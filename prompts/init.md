---
description: Inspect the project and create or improve AGENTS.md
---
Initialize agent guidance for the current project in AGENTS.md (not AGETNS.md).

1. Read any existing AGENTS.md and applicable parent instructions first. Inspect the README, package/build manifests, CI configuration, and a small representative sample of source and tests. Avoid secrets, dependency directories, and generated output.
2. Create a concise, project-specific AGENTS.md in the current project root. Include the project's purpose, relevant directory layout, verified setup/build/check/test commands, coding conventions, and important security or workflow constraints. Only document facts supported by the repository; do not invent commands or claim checks were run.
3. If AGENTS.md already exists, preserve its valid instructions and user-authored content. Make only targeted additions or corrections supported by your inspection; leave it unchanged if it is already sufficient. Do not replace it wholesale or modify unrelated files.
4. Use the normal file tools and respect the active permission mode. If writing is blocked, explain the limitation and stop; do not change modes or bypass restrictions.
5. Briefly summarize what was created, updated, or left unchanged, and mention any important uncertainty.

Additional user guidance (if supplied):
$ARGUMENTS
