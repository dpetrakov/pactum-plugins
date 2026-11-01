# Security

## Reporting

Do not put credentials, private documents or exploit details containing user data in public issues. Use GitHub's **Report a vulnerability** on this repository for a private report. Include the affected version, a synthetic reproducer and the expected boundary.

## Scope

Pactum Docs runs locally as a trusted bb plugin. It reads files in the explicitly selected checkout and can publish review data or send user-authorized batches to bb agent threads. Installing a bb plugin grants code execution on the relevant bb host; the viewer sanitizer is not a sandbox for malicious plugin code.

The viewer does not execute raw document HTML. Static SVG is sanitized and visualizer output is audited. File access is confined to supported regular files; symbolic links and traversal are rejected. Secret masking is applied before storing shared snapshots and producing agent output.

Original-file download is an explicit reviewer action and returns the actual file, including values that the viewer may mask. Keep downloaded files private as appropriate.

## Supported releases

Security fixes are applied to the latest published Documents release. Version ranges and SDK requirements are declared in each plugin package. Review dependency audit results before releasing.
