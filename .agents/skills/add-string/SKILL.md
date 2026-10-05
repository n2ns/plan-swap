---
name: add-string
description: Checklist for adding or changing a user-visible string in PlanSwap — which i18n table it belongs in, the five locales, the terminology table, the manifest nls files, the user guides and the CHANGELOG. Use whenever a change adds, removes or rewords text the user sees in the sidebar, a notification, a quick pick, a command title or a setting description.
---

# Adding or changing a user-visible string

English is the source of truth; every string exists in all five locales of `LOCALES` (`src/i18n.ts`): `en`, `zh-cn`, `zh-tw`, `es`, `ja`. `npm test` (`test/i18n.test.ts`) fails on a missing or extra key, but it cannot check wording, terminology, the user guides or the CHANGELOG: this list does.

## 1. Where the string lives

| Shown by | Table | Called with |
|---|---|---|
| Extension host: notifications, modals, quick picks, status bar, terminal messages, diagnostics | `src/i18n.ts` (`en` first, then `zhCn`, `zhTw`, `es`, `ja`) | host `t('key', { name })` |
| Sidebar Webview | `src/webview/i18n.ts` (same five tables) | Webview `t()`; render account text with `textContent` |
| `package.json` contributions: command titles, view names, setting titles and descriptions, enum labels | `package.nls.json` plus `package.nls.zh-cn.json`, `package.nls.zh-tw.json`, `package.nls.es.json`, `package.nls.ja.json` | `%key%` in the manifest |

Placeholders are `{name}`-style and keep the same names in every locale. Never localize rc marker text, shell commands, file names, setting or command ids, or the account terminal names `Claude (<label>)` / `Codex (<label>)`.

## 2. Wording

- Use the terms of [Localization terminology](../../../docs/development.md#localization-terminology) in every locale; its "Avoid" column lists variants not to reintroduce. A term that must change is changed everywhere in the same commit, with the table.
- Match the existing tone of the table: short, no trailing period on labels, full sentences for messages. `sentenceSeparator` in `LOCALE_INFO` joins sentences, so do not hard-code spaces between them.
- Reuse an existing key when the same text already exists for the same meaning; do not reuse one for a different meaning.

## 3. What else changes in the same commit

- **User guides.** If the string is a label, button or menu entry that `docs/user-guide.md` quotes in **bold** (grep the old English text), update the English guide and `docs/user-guide.zh-cn.md`, `user-guide.zh-tw.md`, `user-guide.es.md`, `user-guide.ja.md` together.
- **Features.** New or changed behavior that the text announces belongs in `docs/features.md` ([doc map](../../../docs/doc-map.md)).
- **CHANGELOG.** A string the user notices (new button, renamed command, changed message) gets a line under `## [Unreleased]` in `CHANGELOG.md`.
- **Preview.** A sidebar string needs the preview verification of `AGENTS.md`: `npm run test:ui` and the layout check at every width and locale (`preview-verify` skill); long translations are the usual cause of wrapping and overflow.

## 4. Verify

`npm run typecheck` (a missing key in a `Record<MessageKey, string>` table is a type error), `npm test` (key parity of the host tables, Webview tables and `package.nls*.json`), and for sidebar strings `npm run test:ui`.
