# 已迁移 → [commandcode-usage](https://github.com/Jovan1666/commandcode-usage)

本插件现在住在 **commandcode-usage** 这个 monorepo 里，位置是
[`plugins/dsh`](https://github.com/Jovan1666/commandcode-usage/tree/main/plugins/dsh)，
和另外六个 agent 的适配器放在一起——Claude Code、Codex、Grok Build、opencode、pi、ZCode。

插件本身没有任何变化：包名不变、cordis loader id 不变、侧栏卡片不变、141 项离线校验不变。

## 安装

```sh
git clone https://github.com/Jovan1666/commandcode-usage
dsh plugin --profile web add ./commandcode-usage/plugins/dsh
```

然后重启 `dsh web` 并刷新页面。

包名仍是 `dsh-commandcode-quota`，所以 loader 行和你已经写过的配置都不用动——只是来源路径变了。

## 已经从本仓库装过了？

已安装的那份照常工作，本仓库没有从你机器上删掉任何东西。要迁到 monorepo：

```sh
dsh plugin --profile web remove dsh-commandcode-quota
git clone https://github.com/Jovan1666/commandcode-usage
dsh plugin --profile web add ./commandcode-usage/plugins/dsh
```

## 想复现旧的环境

本仓库发布的最后一个版本打了标签
[`v0.1.0-final`](../../releases/tag/v0.1.0-final)，需要完全按旧样子复现时钉这个标签：

```sh
git clone --branch v0.1.0-final https://github.com/Jovan1666/dsh-commandcode-quota
dsh plugin --profile web add ./dsh-commandcode-quota
```

## 本仓库已归档

问题、PR 和讨论请到 [monorepo](https://github.com/Jovan1666/commandcode-usage/issues)。

MIT 许可——见 [LICENSE](LICENSE)。
