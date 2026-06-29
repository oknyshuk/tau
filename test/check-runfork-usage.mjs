import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const SOURCE_ROOT = "src";
const ALLOWED_FILES = new Set(["src/app.ts"]);
const EFFECT_MODULE_SPECIFIERS = new Set(["effect", "effect/Effect"]);

/**
 * @typedef {{ readonly line: number; readonly column: number }} ViolationLocation
 */

/**
 * @typedef {{
 * 	readonly parent: Scope | null;
 * 	readonly declaredNames: Set<string>;
 * 	readonly effectAliases: Set<string>;
 * 	readonly runForkAliases: Set<string>;
 * }} Scope
 */

/** @returns {Scope} */
function createScope(parent = null) {
	return {
		parent,
		declaredNames: new Set(),
		effectAliases: new Set(),
		runForkAliases: new Set(),
	};
}

/** @param {Scope} scope */
function createChildScope(scope) {
	return createScope(scope);
}

/** @param {Scope} scope */
function declareName(scope, name) {
	scope.declaredNames.add(name);
}

/** @param {Scope} scope */
function declareEffectAlias(scope, name) {
	declareName(scope, name);
	scope.effectAliases.add(name);
}

/** @param {Scope} scope */
function declareRunForkAlias(scope, name) {
	declareName(scope, name);
	scope.runForkAliases.add(name);
}

/** @param {Scope | null} scope */
function resolveAlias(scope, name, aliasKey) {
	if (scope == null) {
		return false;
	}

	const aliasSet = aliasKey === "effect" ? scope.effectAliases : scope.runForkAliases;
	if (aliasSet.has(name)) {
		return true;
	}

	if (scope.declaredNames.has(name)) {
		return false;
	}

	return resolveAlias(scope.parent, name, aliasKey);
}

/** @param {Scope} scope */
function isEffectAlias(scope, name) {
	return resolveAlias(scope, name, "effect");
}

/** @param {Scope} scope */
function isRunForkAlias(scope, name) {
	return resolveAlias(scope, name, "runFork");
}

function unwrapExpression(expression) {
	let current = expression;
	for (;;) {
		if (
			ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isTypeAssertionExpression(current) ||
			ts.isNonNullExpression(current) ||
			ts.isSatisfiesExpression(current)
		) {
			current = current.expression;
			continue;
		}
		return current;
	}
}

function isPropertyAccess(expression) {
	if (ts.isPropertyAccessExpression(expression)) {
		return true;
	}
	if (typeof ts.isPropertyAccessChain === "function" && ts.isPropertyAccessChain(expression)) {
		return true;
	}
	return false;
}

function isElementAccess(expression) {
	if (ts.isElementAccessExpression(expression)) {
		return true;
	}
	if (typeof ts.isElementAccessChain === "function" && ts.isElementAccessChain(expression)) {
		return true;
	}
	return false;
}

/** @param {Scope} scope */
function isEffectReference(expression, scope) {
	const normalized = unwrapExpression(expression);
	if (ts.isIdentifier(normalized)) {
		return isEffectAlias(scope, normalized.text);
	}
	return false;
}

/** @param {Scope} scope */
function isRunForkMemberReference(expression, scope) {
	const normalized = unwrapExpression(expression);
	if (isPropertyAccess(normalized)) {
		return normalized.name.text === "runFork" && isEffectReference(normalized.expression, scope);
	}
	if (isElementAccess(normalized)) {
		const arg = normalized.argumentExpression;
		return (
			arg !== undefined &&
			(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
			arg.text === "runFork" &&
			isEffectReference(normalized.expression, scope)
		);
	}
	return false;
}

/** @param {Scope} scope */
function isRunForkReference(expression, scope) {
	const normalized = unwrapExpression(expression);
	if (ts.isIdentifier(normalized)) {
		return isRunForkAlias(scope, normalized.text);
	}
	return isRunForkMemberReference(normalized, scope);
}

/** @param {(name: string) => void} register */
function registerBindingNames(bindingName, register) {
	if (ts.isIdentifier(bindingName)) {
		register(bindingName.text);
		return;
	}
	if (ts.isObjectBindingPattern(bindingName)) {
		for (const element of bindingName.elements) {
			registerBindingNames(element.name, register);
		}
		return;
	}
	if (ts.isArrayBindingPattern(bindingName)) {
		for (const element of bindingName.elements) {
			if (!ts.isBindingElement(element)) {
				continue;
			}
			registerBindingNames(element.name, register);
		}
	}
}

/** @param {Scope} scope */
function registerImportDeclaration(importDeclaration, scope) {
	const importClause = importDeclaration.importClause;
	if (!importClause) {
		return;
	}

	const moduleSpecifier = importDeclaration.moduleSpecifier;
	const isEffectImport =
		ts.isStringLiteral(moduleSpecifier) &&
		EFFECT_MODULE_SPECIFIERS.has(moduleSpecifier.text);

	if (importClause.name) {
		declareName(scope, importClause.name.text);
	}

	if (!importClause.namedBindings) {
		return;
	}

	if (ts.isNamespaceImport(importClause.namedBindings)) {
		if (isEffectImport) {
			declareEffectAlias(scope, importClause.namedBindings.name.text);
			return;
		}
		declareName(scope, importClause.namedBindings.name.text);
		return;
	}

	for (const element of importClause.namedBindings.elements) {
		const importedName = element.propertyName?.text ?? element.name.text;
		if (isEffectImport && importedName === "Effect") {
			declareEffectAlias(scope, element.name.text);
			continue;
		}
		if (isEffectImport && importedName === "runFork") {
			declareRunForkAlias(scope, element.name.text);
			continue;
		}
		declareName(scope, element.name.text);
	}
}

/** @param {Scope} scope */
function registerVariableDeclaration(declaration, scope) {
	const initializer = declaration.initializer;

	if (ts.isIdentifier(declaration.name)) {
		const bindingName = declaration.name.text;
		if (initializer && isEffectReference(initializer, scope)) {
			declareEffectAlias(scope, bindingName);
			return;
		}
		if (initializer && isRunForkReference(initializer, scope)) {
			declareRunForkAlias(scope, bindingName);
			return;
		}
		declareName(scope, bindingName);
		return;
	}

	if (ts.isObjectBindingPattern(declaration.name)) {
		const hasEffectInitializer = initializer !== undefined && isEffectReference(initializer, scope);
		for (const element of declaration.name.elements) {
			if (!ts.isIdentifier(element.name)) {
				registerBindingNames(element.name, (name) => declareName(scope, name));
				continue;
			}

			if (!hasEffectInitializer) {
				declareName(scope, element.name.text);
				continue;
			}

			const sourceProperty =
				element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
					? element.propertyName.text
					: element.name.text;

			if (sourceProperty === "runFork") {
				declareRunForkAlias(scope, element.name.text);
				continue;
			}

			declareName(scope, element.name.text);
		}
		return;
	}

	registerBindingNames(declaration.name, (name) => declareName(scope, name));
}

/** @returns {ViolationLocation[]} */
function findRunForkUsages(sourceText, filePath) {
	const sourceFile = ts.createSourceFile(
		filePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	/** @type {ViolationLocation[]} */
	const violations = [];

	/** @param {ts.Node} node @param {Scope} scope */
	const visit = (node, scope) => {
		if (ts.isSourceFile(node)) {
			for (const statement of node.statements) {
				visit(statement, scope);
			}
			return;
		}

		if (ts.isImportDeclaration(node)) {
			registerImportDeclaration(node, scope);
			return;
		}

		if (ts.isFunctionDeclaration(node)) {
			if (node.name) {
				declareName(scope, node.name.text);
			}
			const functionScope = createChildScope(scope);
			for (const parameter of node.parameters) {
				registerBindingNames(parameter.name, (name) => declareName(functionScope, name));
			}
			if (node.body) {
				visit(node.body, functionScope);
			}
			return;
		}

		if (
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isConstructorDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node)
		) {
			const functionScope = createChildScope(scope);
			if (ts.isFunctionExpression(node) && node.name) {
				declareName(functionScope, node.name.text);
			}
			for (const parameter of node.parameters) {
				registerBindingNames(parameter.name, (name) => declareName(functionScope, name));
			}
			visit(node.body, functionScope);
			return;
		}

		if (ts.isBlock(node)) {
			const blockScope = createChildScope(scope);
			for (const statement of node.statements) {
				visit(statement, blockScope);
			}
			return;
		}

		if (ts.isCatchClause(node)) {
			const catchScope = createChildScope(scope);
			if (node.variableDeclaration) {
				registerBindingNames(node.variableDeclaration.name, (name) => declareName(catchScope, name));
			}
			visit(node.block, catchScope);
			return;
		}

		if (ts.isClassDeclaration(node) && node.name) {
			declareName(scope, node.name.text);
		}

		if (ts.isVariableDeclaration(node)) {
			registerVariableDeclaration(node, scope);
			if (node.initializer) {
				visit(node.initializer, scope);
			}
			return;
		}

		if (ts.isCallExpression(node) && isRunForkReference(node.expression, scope)) {
			const { line, character } = sourceFile.getLineAndCharacterOfPosition(
				node.expression.getStart(sourceFile),
			);
			violations.push({ line: line + 1, column: character + 1 });
		}

		ts.forEachChild(node, (child) => visit(child, scope));
	};

	visit(sourceFile, createScope());
	return violations;
}

/** @returns {string[]} */
function listTypeScriptFiles(dirPath) {
	const entries = readdirSync(dirPath);
	const files = [];

	for (const entry of entries) {
		const absolutePath = path.join(dirPath, entry);
		const stats = statSync(absolutePath);
		if (stats.isDirectory()) {
			files.push(...listTypeScriptFiles(absolutePath));
			continue;
		}

		if (absolutePath.endsWith(".ts")) {
			files.push(absolutePath);
		}
	}

	return files;
}

/**
 * Enforcement entry point: returns `path:line` violations for every disallowed
 * `Effect.runFork` usage under `<projectRoot>/src` (only `src/app.ts` is allowed).
 * @param {string} projectRoot
 * @returns {string[]}
 */
function collectRunForkViolations(projectRoot) {
	const files = listTypeScriptFiles(path.join(projectRoot, SOURCE_ROOT));
	const violations = [];

	for (const file of files) {
		const relativePath = path.relative(projectRoot, file).replaceAll(path.sep, "/");
		if (ALLOWED_FILES.has(relativePath)) {
			continue;
		}
		const locations = findRunForkUsages(readFileSync(file, "utf8"), file);
		for (const location of locations) {
			violations.push(`${relativePath}:${location.line}`);
		}
	}

	return violations;
}

function main() {
	const sourceDir = path.resolve(SOURCE_ROOT);
	const files = listTypeScriptFiles(sourceDir);
	const violations = [];

	for (const file of files) {
		const relativePath = path.relative(process.cwd(), file).replaceAll(path.sep, "/");
		const sourceText = readFileSync(file, "utf8");

		const locations = findRunForkUsages(sourceText, file);
		if (locations.length === 0 || ALLOWED_FILES.has(relativePath)) {
			continue;
		}

		for (const location of locations) {
			violations.push(`${relativePath}:${location.line}`);
		}
	}

	if (violations.length === 0) {
		return;
	}

	console.error("Effect.runFork is restricted to approved modules:");
	for (const location of violations) {
		console.error(`  - ${location}`);
	}
	process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	main();
}

export { collectRunForkViolations, findRunForkUsages };
