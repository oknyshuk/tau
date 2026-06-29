---
name: code-review
description: Guidelines for performing thorough code reviews with security and quality focus.
---

# Code Review Skill

Use this skill when reviewing code changes, pull requests, or auditing existing code.

## Review Checklist

### 1. Security First
- [ ] No hardcoded secrets, API keys, or credentials
- [ ] Input validation on all user-provided data
- [ ] Database queries use parameterized statements or safe query builders (no string concatenation)
- [ ] File operations validate paths (no path traversal)
- [ ] Authentication and authorization checks are present where needed

### 2. Error Handling
- [ ] All external calls (API, DB, file, network) have explicit error handling
- [ ] Errors are logged with context, but without sensitive data
- [ ] User-facing errors are helpful and do not leak internals
- [ ] Resources are cleaned up with `try/finally`, Effect scopes, or equivalent lifecycle management

### 3. Code Quality
- [ ] Functions do one thing and are reasonably sized (<50 lines ideal)
- [ ] Variable names are descriptive (no single letters except loops)
- [ ] No commented-out code left behind
- [ ] Complex logic has explanatory comments when the intent is not obvious from the code
- [ ] No duplicate code (DRY principle)

### 4. Testing Considerations
- [ ] Edge cases handled (empty inputs, nulls, boundaries)
- [ ] Happy path and error paths both work
- [ ] New code has corresponding tests (if a test suite exists)

## Review Response Format

When providing review feedback, structure it as:

```markdown
## Summary
[1-2 sentence overall assessment]

## Critical Issues (Must Fix)
- Issue 1: [description + suggested fix]
- Issue 2: ...

## Suggestions (Nice to Have)
- Suggestion 1: [description]

## Questions
- [Any clarifying questions about intent]
```

## Common Patterns to Flag

### TypeScript
```ts
// Bad: SQL injection risk
const query = `SELECT * FROM users WHERE id = ${userId}`;
await db.query(query);

// Good: Parameterized query
await db.query("SELECT * FROM users WHERE id = $1", [userId]);
```

### Frontend TypeScript
```ts
// Bad: XSS risk
element.innerHTML = userInput;

// Good: Safe text content
element.textContent = userInput;
```

## Tone Guidelines

- Be constructive, not critical
- Explain why something is an issue, not just what
- Offer solutions, not just problems
- Acknowledge good patterns you see
