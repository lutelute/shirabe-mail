import { useState, useEffect } from 'react';

const SKILL_NAME = 'todo-analysis';

const DEFAULT_PROMPT = `---
description: "メール分析からTODOを抽出するプロンプト"
---

あなたはメール分析アシスタントです。
MCPツールを使って最近のメールを確認し、ユーザーが対応すべきTODOを抽出してください。

## 手順

1. get_unread_mails で未読メールを取得
2. 重要そうなメールは get_mail_detail で詳細を確認
3. 必要に応じて get_mail_thread でスレッドの文脈を確認

## 重要: 出力ルール

- 出力は **Markdown形式** で直接記述すること
- コードブロックで囲まないこと（\`\`\`markdown ... \`\`\` のような囲みは禁止）
- チェックボックスリスト（- [ ]）を使って各TODOを記載
- 見出し（#, ##）で構造化すること
- 該当がないセクションは省略してよい

## 出力テンプレート

# メール分析結果

## 高優先度

- [ ] **アクション内容をここに書く**
  - 期限: YYYY/MM/DD（推定）
  - From: 送信者名
  - 件名: メール件名
  - 理由: なぜ高優先度か

## 中優先度

- [ ] **アクション内容をここに書く**
  - From: 送信者名
  - 件名: メール件名

## 低優先度

- [ ] **アクション内容をここに書く**
  - From: 送信者名
  - 件名: メール件名

## 概要

| 項目 | 件数 |
|------|------|
| 分析したメール | N通 |
| アクション必要 | N件 |
| 情報共有のみ | N件 |
`;

/**
 * Loads the analysis prompt from the `todo-analysis` skill.
 * Creates the skill with the default prompt if it doesn't exist.
 */
export function useAnalysisPrompt(): string {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);

  useEffect(() => {
    (async () => {
      const content = await window.electronAPI.getSkillContent(SKILL_NAME);
      if (content) {
        setPrompt(content);
      } else {
        await window.electronAPI.saveSkillContent(SKILL_NAME, DEFAULT_PROMPT);
        setPrompt(DEFAULT_PROMPT);
      }
    })();
  }, []);

  return prompt;
}
