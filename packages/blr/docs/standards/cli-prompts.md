# CLI Prompt Writing

## Purpose

Keep CLI prompts easy to scan, easy to answer, and consistent across `blr`.

## Core Rules

1. Prompt only when necessary.
2. Prefer config, environment variables, CLI flags, and built-in defaults over repeated prompt pages.
3. Use a programmatic tone when presenting facts.
4. Use concise, direct wording when asking the user to choose.
5. Do not write prompts in a bot persona.

## Wording Rules

- Prefer short labels such as:
  - `Current:`
  - `Next:`
  - `Latest stable:`
  - `Status:`
- When comparing versions or values, show the current value before the next or suggested value.
- End prompt bodies with a short question such as:
  - `Choose an action:`
  - `Continue?`
  - `Install dependencies?`
- Use `you` only when it helps explain an action.
- Avoid `I`, `me`, and conversational bot framing.
- Avoid long explanatory paragraphs inside prompt bodies.

## Choice Labels

- Keep choice titles short and action-oriented.
- Prefer patterns such as:
  - `Update to 1.2.3`
  - `Keep current`
  - `Silence 24h`
  - `Local server`
  - `Watch scripts`
- Put the most likely or safest action first when the prompt type allows it.

## Checklist Pages

- Use `Choose ...` wording for select and multiselect pages.
- Keep checklist titles noun-focused:
  - `Choose dev actions`
  - `Choose watch items`
  - `Choose pack actions`
- Avoid repeating the same context in every choice title when the page title already provides it.

## Confirmations

- Keep confirmations to one short question.
- When a confirmation changes a version or path, show the current and next values first, then ask the question.

## Review Questions

Before merging a prompt change, check:

1. Is this prompt necessary?
2. Are the important values visible at a glance?
3. Is the wording concise and non-conversational?
4. Do the choice labels scan cleanly in a terminal?
