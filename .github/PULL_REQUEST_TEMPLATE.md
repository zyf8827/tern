## 变更描述 (Description)

<!-- 简要说明本次 Pull Request 解决的问题或引入的新特性 -->

- 修复/新增了...
- 关联 Issue：Fixes #

## 变更类型 (Type of Change)

- [ ] 缺陷修复 (Bug fix)
- [ ] 新功能 (New feature)
- [ ] 代码重构 (Refactoring)
- [ ] 文档更新 (Documentation)
- [ ] CI/CD 或工程化改进 (Chore / CI)

## 验证与自测 (Verification)

<!-- 描述你如何测试了这些改动 -->

- [ ] `pnpm -r build` 构建成功
- [ ] `pnpm test:unit` 单元测试全部通过
- [ ] `pnpm lint` 与 `pnpm format:check` 检查通过
- [ ] （可选）本地启动 dev 脚本或 Docker 实测

## 脱敏合规检查 (Sanitization Checklist)

- [ ] 代码、注释与提交信息中**不包含**任何企业内网 IP、私有域名或未授权凭据。
- [ ] 测试用例与示例均使用通用标识（如 `127.0.0.1`、`portal`、`demo-app`、`session_token`）。
