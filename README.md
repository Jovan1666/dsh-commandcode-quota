# Moved → [commandcode-usage](https://github.com/Jovan1666/commandcode-usage)

This plugin lives in the **commandcode-usage** monorepo now, under
[`plugins/dsh`](https://github.com/Jovan1666/commandcode-usage/tree/main/plugins/dsh),
next to adapters for six other agents — Claude Code, Codex, Grok Build, opencode, pi and ZCode.

Nothing about the plugin itself changed: same package name, same cordis loader id,
same sidebar card, same 141 offline checks.

## Install

```sh
git clone https://github.com/Jovan1666/commandcode-usage
dsh plugin --profile web add ./commandcode-usage/plugins/dsh
```

Then restart `dsh web` and reload the page.

The package name is still `dsh-commandcode-quota`, so the loader row and any config you
already wrote keep working unchanged — only the source path differs.

## Already installed from this repository?

Your installed copy keeps working; nothing here was deleted from your machine. To move to
the monorepo, remove the old one and add the new path:

```sh
dsh plugin --profile web remove dsh-commandcode-quota
git clone https://github.com/Jovan1666/commandcode-usage
dsh plugin --profile web add ./commandcode-usage/plugins/dsh
```

## Reproducing an old setup

The last version published from this repository is tagged
[`v0.1.0-final`](../../releases/tag/v0.1.0-final). Pin that tag if you need to reproduce a
setup exactly as it was:

```sh
git clone --branch v0.1.0-final https://github.com/Jovan1666/dsh-commandcode-quota
dsh plugin --profile web add ./dsh-commandcode-quota
```

## This repository is archived

Issues, pull requests and questions belong in the
[monorepo](https://github.com/Jovan1666/commandcode-usage/issues).

Licensed MIT — see [LICENSE](LICENSE).
