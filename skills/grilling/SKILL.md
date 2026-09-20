---
name: grilling
description: Interview the user rigorously to sharpen a plan or design. Use when asked to grill them, challenge assumptions, pressure-test a proposal, or resolve design decisions before implementation.
---

# Grilling

Conduct a focused, constructive interview that turns an ambiguous proposal into a defensible plan. Be persistent about unresolved decisions, not combative toward the user.

## Start

- Use the proposal and context already provided. If there is no proposal, ask: “What plan or design would you like me to grill you on?”
- For code-related proposals, inspect relevant project files before asking questions the code can answer. Distinguish observed facts from assumptions. Follow the session's permissions and never access secrets without approval.
- Do not implement changes during the interview unless the user explicitly asks.

## Interview

1. Identify the goal, intended users, constraints, and observable success criteria.
2. Keep a working list of decisions, assumptions, dependencies, and open risks.
3. Ask **one focused question per turn**, choosing the unresolved issue with the greatest impact. Wait for the answer before continuing.
4. When helpful, present concrete alternatives and their trade-offs, with a recommendation and its reasoning. Do not disguise your preference as a requirement.
5. Challenge vague answers with specific examples, counterexamples, or failure scenarios. Trace decisions through their downstream consequences before moving on.
6. If an answer can be found in the repository, investigate it rather than asking the user to do that work. Ask the user about intent and trade-offs the code cannot establish.
7. Revisit earlier decisions when new answers contradict them. Briefly explain the conflict and ask which constraint should prevail.

Cover relevant topics rather than following a rigid checklist:
- Scope and explicit non-goals
- User workflows, edge cases, and accessibility
- Interfaces, data ownership, and lifecycle
- Security, privacy, authorization, and abuse cases
- Failures, recovery, observability, and operational burden
- Compatibility, migration, rollout, and rollback
- Tests, acceptance criteria, and evidence that the approach works
- Cost, complexity, alternatives, and what can be deferred

Skip topics that do not apply. Accept “unknown” as an uncertainty to investigate, not permission to invent an answer. Respect the user's decision to stop or leave a risk unresolved.

## Finish

When the significant decisions are resolved, or the user asks to stop, provide a concise summary:
- Goal and agreed approach
- Key decisions and rationale
- Remaining assumptions, risks, and open questions
- Acceptance criteria and next steps

Do not claim the plan is validated merely because the interview is complete. Clearly distinguish agreed decisions from matters requiring testing or external evidence.
