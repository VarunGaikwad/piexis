# Permission Modes

Six modes total, not four. Config value in parentheses; status bar text in brackets.

## 1. Manual (`default`)

`[⏸ manual mode on]`

Asks for approval before almost everything. Only reads run without a prompt.

## 2. Accept Edits (`acceptEdits`)

`[⏵⏵ accept edits on]`

Auto-approves file edits **and** a fixed whitelist of filesystem bash commands: `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed` — but only inside your working directory. Everything else (git push, npm install, arbitrary bash) still prompts.

## 3. Plan (`plan`)

`[⏸ plan mode on]`

Read-only. PI explores and writes a plan, but does not edit anything. You must explicitly approve the plan before edits happen. The plan is PI's proposal — not a guarantee it's correct.

## 4. Auto (`auto`)

`[⏵⏵ auto mode on]`

Everything runs without prompting you, but a separate classifier model reviews each action in the background and blocks risky ones (`curl | bash`, force pushes, secret exfiltration, prod deploys, etc.). **Not the same as bypass/YOLO mode** — there's still a safety net. This is now the default starting mode on Pro/Max/Team plans.

## 5. Don't Ask (`dontAsk`)

`[⏵⏵ don't ask on]`

No classifier, no prompts. Runs only pre-approved actions; silently denies anything that would need a prompt. Built for CI/scripts, not interactive use.

## 6. Bypass Permissions (`bypassPermissions`)

`[⏵⏵ bypass permissions on]`

True YOLO mode. No checks at all, not even the classifier. Only safe inside an isolated container/VM. Launch-only: use `--permission-mode bypassPermissions` or `--dangerously-skip-permissions`.

---

### Key distinction

People often conflate **auto mode** with **bypass permissions**. They are not the same risk tier:

- Auto mode → classifier reviews actions in the background.
- Bypass permissions → nothing reviews anything.

### Switching modes

Press `Alt+M` to cycle: `default → acceptEdits → plan → (auto if available) → default`. `dontAsk` and `bypassPermissions` never appear in the cycle; select them only at launch with `--permission-mode`. Use `/plan` or `/plan <task>` to enter Plan mode and optionally start planning immediately.
