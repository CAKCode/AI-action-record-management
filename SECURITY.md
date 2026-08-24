# 安全说明

## 报告安全问题

请通过 GitHub 仓库的 Private vulnerability reporting 提交安全问题，不要在公开 Issue 中披露漏洞细节、凭据、日志、报告或备份内容。报告中应包含受影响版本、复现条件、影响范围和建议的缓解措施，但不得附带仍然有效的生产密钥。

## 凭据管理

- 真实账号、密码、API Key、Token、私钥和云服务凭据只能通过部署环境或权限为 `0600` 的仓库外配置文件注入。
- 不要把 `.env`、`service.env`、`auth.json`、证书私钥、数据库、日志、pytest 报告、Session runtime 或恢复包提交到 Git。
- `.gitignore` 只覆盖常见误提交路径，不能代替提交前审查。提交前必须检查暂存文件列表和暂存差异。
- 如果凭据曾进入 Git 历史、构建日志或公开制品，应立即吊销并轮换；仅删除当前文件不能消除历史泄露。

## 部署边界

- 监听非回环地址时必须同时配置 `CODEX_DESK_AUTH_USER` 和 `CODEX_DESK_AUTH_PASSWORD`。
- 生产环境应使用专用非 root 服务账户，并限制 data、runtime、backup 和 task workspace 的访问权限。
- Task 指令、命令、终端 transcript、后台日志、Skill 报告和 pytest artifact 按原始证据保存，可能包含凭据或业务数据。它们必须按高敏感数据管理。
- 数据库备份和恢复检查点不等同于脱敏副本。传输、存放和销毁都必须遵循与在线数据相同的访问控制要求。

完整的部署加固、权限和恢复要求见[部署与运维](docs/OPERATIONS.md)及[数据与恢复](docs/DATA_AND_RECOVERY.md)。
