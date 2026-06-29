---
name: ralph-loop-creation
description: Create compact Ralph loop task files when the user explicitly asks to prepare a Ralph loop, usually from a backlog epic or task. Use for task-file creation only; in-loop agent behavior belongs to the Ralph loop prompt.
---

# Ralph Loop Creation

## Core Idea

A Ralph task file is injected into every later loop iteration. Keep it short, current, and useful for continuation.

For backlog-backed work, the backlog is the source of truth. The Ralph task file is only a compact prompt with pointers, a short checklist, and an empty notebook area for later loop iterations.

Do not copy backlog descriptions, designs, or acceptance criteria into the Ralph file. The next agent should read the backlog item directly.

## Creating a Task File

Write the task file directly at `.pi/loops/tasks/<name>.md` using the available file editing tool.

Pick a concise lowercase hyphenated name. If the work comes from a backlog item, use the backlog id as the file name, for example `.pi/loops/tasks/foo-31z.md`.

Before writing a backlog-backed file, inspect the backlog source:

```text
backlog show <id>
```

If the source is an epic or may have children, also inspect its task tree:

```text
backlog children <id> --recursive
```

## Backlog-Backed Epic Template

Use this shape for the common case where Ralph work starts from a backlog epic.

```markdown
# <short title>

Backlog source: `<epic-id>`

First action:
- Run `backlog show <epic-id>`
- Run `backlog children <epic-id> --recursive`

Treat backlog as the source of truth. Use this file only as the loop notebook.

## Tasks

- [ ] `<task-id>` — <very short outcome>
- [ ] `<task-id>` — <very short outcome>
- [ ] `<task-id>` — <very short outcome>

## Notebook

- 
```

Task checklist rules:

- Use backlog child ids when they exist.
- Keep descriptions dramatically short, usually 3-8 words.
- Do not paste acceptance criteria.
- Do not paste design details.
- The checklist exists for later completion tracking inside the loop.

## Backlog-Backed Single Item Template

Use this shape when the source is one task, bug, or feature rather than an epic.

```markdown
# <short title>

Backlog source: `<item-id>`

First action:
- Run `backlog show <item-id>`

Treat backlog as the source of truth. Use this file only as the loop notebook.

## Checklist

- [ ] Implement backlog item
- [ ] Verify acceptance criteria
- [ ] Record evidence / handoff

## Notebook

- 
```

## Free-Form Task Template

Use this only when there is no backlog source.

```markdown
# <short title>

## Objective

<one or two sentences>

## Checklist

- [ ] <short item>
- [ ] <short item>
- [ ] <short item>

## Notebook

- 
```

Free-form files need enough context to continue without chat history, but they should still stay compact.

## Notebook Purpose

The notebook section is reserved for the Ralph loop prompt and later loop iterations. Creation should leave it empty or with a single blank bullet.

## What Does Not Belong

- lifecycle or operator instructions
- copied backlog descriptions, designs, or acceptance criteria
- long implementation plans
- large code snippets
- status prose that can be represented by checking a box
- information that the next agent can get by running the listed backlog commands
