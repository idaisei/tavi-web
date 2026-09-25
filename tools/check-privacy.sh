#!/bin/bash
# 公開リポジトリに個人が特定できるものが混ざっていないか調べる。
# 一度出したものは取り消せない。コミット前に必ず通すこと。
#
# 探す語そのものは tools/privacy-words.txt に置き、git には入れない。
# リストを公開リポジトリへ入れたら、隠したいものを自分で公開することになる。
set -u
cd "$(dirname "$0")/.." || exit 1

LIST="tools/privacy-words.txt"
if [ ! -f "$LIST" ]; then
  echo "✗ $LIST がありません。tools/privacy-words.example.txt を写して作ってください。"
  exit 1
fi

fail=0
# 自分自身とリストは対象から外す
EXCLUDES=(--exclude-dir=.git --exclude=check-privacy.sh --exclude=privacy-words.txt)

while IFS= read -r word; do
  [ -z "$word" ] && continue
  case "$word" in \#*) continue ;; esac
  hits=$(grep -rniF "$word" . "${EXCLUDES[@]}" 2>/dev/null)
  if [ -n "$hits" ]; then
    echo "✗ 出してはいけない語が入っています（$word）:"
    echo "$hits"
    fail=1
  fi
done < "$LIST"

paths=$(grep -rn "$(printf '/Us''ers/')" . "${EXCLUDES[@]}" 2>/dev/null)
if [ -n "$paths" ]; then
  echo "✗ ローカルのパスが入っています:"; echo "$paths"; fail=1
fi

# コミットの作者名は既定だとシステムの本名になる。リポジトリごとの上書きを確かめる。
author="$(git config user.name || true)"
email="$(git config user.email || true)"
if [ -z "$author" ]; then
  echo "✗ このリポジトリの作者名が未設定です。システム既定（本名）が使われます。"
  echo "  git config user.name  \"表に出す名前\""
  echo "  git config user.email \"表に出すメール\""
  fail=1
fi

authors="$(git log --format='%an <%ae>' 2>/dev/null | sort -u || true)"
while IFS= read -r word; do
  [ -z "$word" ] && continue
  case "$word" in \#*) continue ;; esac
  if echo "$author <$email>" | grep -qiF "$word"; then
    echo "✗ コミットの作者名に出せない語が入っています: $author <$email>"; fail=1
  fi
  if [ -n "$authors" ] && echo "$authors" | grep -qiF "$word"; then
    echo "✗ 過去のコミットの作者名に出せない語が残っています:"; echo "$authors"; fail=1
  fi
done < "$LIST"

if [ "$fail" -eq 0 ]; then
  echo "✓ 個人情報の検査：問題なし（作者 $author <$email>）"
fi
exit "$fail"
