# Extended Context Tools

Adds extra options to the Explorer right-click menu. All of them work with multiple selected items.

- **Duplicate** – copies a file or folder next to the original. You're asked for the new name (defaults to `name copy.ext`, then `name copy 2.ext`, …). Duplicated files open automatically.
- **File Info** – shows path, size, line count (text files), created/modified dates, owner, group and permissions in an editor tab. For folders, shows the number of files/folders and total size. Buttons copy the path or the whole info.
- **Copy Path As…** – choose a format: relative, absolute, file name, name without extension, containing folder, relative to the open file (import style, e.g. `../utils/date.js`) or `file://` URI. Each option previews the result.
- **Compare With…** – select two files to diff them straight away, or one file and pick what to compare against: the open file, the clipboard, any workspace file (searchable), or a file from disk.
- **Rename: Change Case…** – converts names to camelCase, PascalCase, kebab-case, snake_case, CONSTANT_CASE, Title Case, lowercase or UPPERCASE. Extensions are kept (`user-profile.test.ts` → `UserProfile.test.ts`), and open editors follow the rename.

## Build & install

```sh
npm run package          # creates extended-context-tools-<version>.vsix
npm run install-codium   # installs it into VSCodium
```

Then reload the window (Cmd+Shift+P → "Developer: Reload Window").
