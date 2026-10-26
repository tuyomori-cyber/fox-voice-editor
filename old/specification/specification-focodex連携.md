# Focodex受信バッファ連携

2026-10-22策定、2026-10-25 v0.2.1整合。fox-voice-editor v0.2.1の「Focodexへ貼り付け」を補足する追加仕様。

プレビュー付近の「Focodexへ貼り付け」で、コピーと同じ`joinedText()`を送る。Focodexの受信バッファへ文章を渡す機能とし、実行はFocodexで明示的に行う。

送信先は既定で`focodex@foxbook.example`、設定変更は端末内へ保存する。新規送信は新しい要求IDを作り、送信先・要求ID・本文を保存する。応答消失時は自動再送せず、ユーザーが「同じ文章を再送」を押した場合だけ同じID・本文で再送する。応答は`accepted`、`duplicate`、`rejected`だけであり、状態照会は行わない。元の文章とコピー機能を残す。

送信元は編集ページだけとする。外部からの中継要求やWebページ向けAPIは設けない。FocodexはFirefox提供のIDとURLを検証し、下書き専用APIで受信する。トークンや暗号化は初版に追加しない。

正式な通信・保存・セキュリティ契約は`../focodex/specification/draft-api-v1.md`を参照。Focodexの認証失敗時の副作用ゼロ、同時受信の直列化、FIFO、切断・再起動時の保存整合性を重点確認する。
