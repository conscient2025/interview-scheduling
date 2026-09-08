# 面试排班

本仓库维护浙江大学粤语社纳新面试的结构化排班数据和确定性处理脚本。正式数据位于 `main` 分支；原始报名表和生成的 XLSX 仅保存在本地。

## 数据文件

- `data/applicants.csv`：学号、姓名、可用场次和正式安排。
- `data/slots.csv`：允许使用的线下面试场次。
- `config/schedule.json`：分组容量、排序偏好和特殊选项规则。

仓库不保存专业、性别、部门志愿、表演部兼职意向、电话、QQ、IP 或问卷自由回答。

## 本地更新

在 Codex 工作区依赖可用的环境中执行：

```powershell
node scripts/update-schedule.mjs --input "incoming/最新报名表.xlsx"
```

脚本会更新 CSV、生成本地 XLSX 和冲突报告。推送 `main` 由本地 Skill 在校验通过后完成，禁止 force push。

