# agents/

Both upstream agent definitions are ported here (**Phase 3, done**): the directory holds
`poteto-agent.md` and `comment-sicko.md`, matching the pin's two files, with
[`../tests/agents.spec.ts`](../tests/agents.spec.ts) checking they stay named and present.

| Upstream agent | Role in pstack | DSH shape | File |
|---|---|---|---|
| `poteto-agent` | routing target for `/poteto-mode` and ad-hoc playbook helpers | a `role` value on `pstack_spawn` | `agents/poteto-agent.md` |
| `comment-sicko` | read-only comment reviewer for `/no-comments` | a `role` value, read-only by instruction | `agents/comment-sicko.md` |

## How a role maps to a file

A `role` is the `name:` in this directory: `pstack_spawn` with `role: comment-sicko` resolves to
`agents/comment-sicko.md`, so the file stem and the `name:` are the same token. DSH validates a
name against `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` (`dsh-skill/lib/index.js:17`), which is why the
frontmatter carries two translations from upstream: `name: Comment Sicko` → `name: comment-sicko`,
and `is_background: true` → **deleted** (a Cursor agent field with no DSH meaning; inventing an
equivalent would be a lie). Call sites inside the bodies follow the same table as
[`../skills/README.md`](../skills/README.md): `Task` → `pstack_spawn`, `subagent_type: X` →
`role: X`. Everything else is byte-identical to the pin.

## Note on the DSH mapping

DSH has no `subagent_type` field on the model-facing tool, and a DSH child inherits the
parent's permissions. So "read-only" is an **instruction**, not a sandbox.

That is weaker than upstream, where a reviewer is spawned so it *physically* cannot write.
Say so in the skill text rather than implying a guarantee we cannot make.
