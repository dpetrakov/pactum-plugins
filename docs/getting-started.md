# Getting started

## Requirements

- bb 0.46 or later with Plugin SDK 0.6.49 or later.
- Git and a valid `user.name`/`user.email` for saving review state.
- A supported text document no larger than 8 MiB.

## Review a document

1. Install the Documents plugin using the command in the repository README.
2. Open **Documents** and choose the machine and checkout containing your files.
3. Enable review in that checkout when you want to save annotations and read marks. Choose review roots and exclusions in **Review settings**.
4. Open a document. Compare changes since your read state, or use **Raw** for structured/source text.
5. Select text and add a comment. Choose an instruction for the agent or a personal note.
6. Use **Send to agent** when the batch is ready. Review the destination and scope. The batch goes to a bb thread in the same checkout.
7. Inspect replies and linked edits. Accept results or reply with another instruction. Acceptance belongs to the reviewer.

Newly discovered files remain read until their first explicit opening creates the starting base. Changes after that opening become unread. Existing read history is preserved. Adjacent blocks with the same mark form one review stop; **Mark read** confirms their shown versions together. Undo restores the mark contribution. A file changed again after display remains unread for those newer versions.

## Information and downloads

The Info button shows the file's absolute path, checkout-relative path, format and byte size. Each path has its own copy button. **Download original** saves the file's actual bytes, preserving line endings and encoding. If it changes during download, retry from updated information.

## Useful shortcuts

The **Keyboard shortcuts** item lists the active shortcuts. Common actions include J/K to move through review stops, R to mark a stop read, A to accept an answered item, C to comment, and D to toggle diffs. Shortcuts do not intercept typing in text fields.

## Update or remove

```sh
bb plugin outdated
bb plugin update document-review
bb plugin remove document-review
```

Removing the plugin does not delete `.bb-docs` from your Git checkout. Review device-local data and your backups before removing or moving the plugin. Do not delete `.bb-docs` merely to reinstall or update.
