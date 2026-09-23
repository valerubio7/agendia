# Pinned source pre-import guard

After root-owned `bun install --frozen-lockfile --ignore-scripts`, run this separate guard before importing or executing `scripts/deployctl.ts`. Replace both commit placeholders with the same pinned 40-hex commit. A failure is a stop, not permission to remove dependencies or relax the checkout checks.

```sh
sudo env -i PATH=/usr/bin:/bin sh -ceu '
r=/opt/agendia/tooling/<40-hex-commit>
cd "$r"
test "$PWD" = "$r"
test -s bun.lock
test "$(git rev-parse HEAD)" = "<40-hex-commit>"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
expected=$(printf "%s\n" \
  "!! node_modules/" \
  "!! apps/api/node_modules/" \
  "!! apps/message-worker/node_modules/" \
  "!! apps/web/node_modules/" \
  "!! apps/whatsapp-manager/node_modules/" \
  "!! packages/ai-deepseek/node_modules/" \
  "!! packages/whatsapp-baileys/node_modules/" | sort)
actual=$(git status --porcelain=v1 --ignored --untracked-files=normal | sort)
test "$actual" = "$expected"
unsafe=$(find -L "$r" -xdev \( ! -user root -o -perm /022 \) -print -quit)
test -z "$unsafe"
'
```

This checks checkout identity, lock presence, clean tracked/untracked status, exactly seven expected ignored workspace dependency directories (no missing, duplicate, or extra entries), and recursive ownership and write modes. `find -L` follows Bun workspace symlinks so their targets receive the same ownership/mode check rather than treating valid symlinks as writable. This guard does not check ignored dependency byte integrity.
