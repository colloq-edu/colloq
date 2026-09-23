# Getting help

## Read first

- **Guides:** <https://colloq.ru/docs/en/> in English, <https://colloq.ru/docs/>
  in Russian. They cover installing, running a class, room rules, lectures,
  Council, the Oracle, environments, publishing, backups and updates.
- **Something is broken:** start with the troubleshooting guide at
  <https://colloq.ru/docs/en/troubleshooting.html>.
- **Before a class:** run `colloq doctor`. From a source checkout, run
  `node --import tsx cli/src/bin.ts doctor`. It checks Node, Docker, ports and
  disk without touching the network.
- **Operators:** [deploy/k3s/README.md](deploy/k3s/README.md) covers
  single-node production, [deploy/vast/README.md](deploy/vast/README.md) covers
  a rented vast.ai machine, and [runtime/README.md](runtime/README.md) covers the
  room isolation boundary.

## Ask

This repository has one maintainer and no chat or mailing list. Use GitHub
issues:

- **Bug:** open a [bug report](https://github.com/colloq-edu/colloq/issues/new?template=bug_report.yml).
  Include `colloq --version`, how you installed Colloq, and logs with tokens
  removed.
- **Idea or missing feature:** open a [feature request](https://github.com/colloq-edu/colloq/issues/new?template=feature_request.yml).
  Describe the class situation it is for.
- **Question:** open a [blank issue](https://github.com/colloq-edu/colloq/issues/new)
  and say what you tried and which guide you read.

Please search [existing issues](https://github.com/colloq-edu/colloq/issues?q=is%3Aissue)
first. Issues and pull requests are welcome in English or Russian.

**Security problems never go into issues.** See [SECURITY.md](SECURITY.md).

## What we can't help with

- Classes on someone else's instance. Ask whoever runs it.
- Accounts, grades or content inside a class. Colloq has no central service,
  so every instance belongs to whoever runs it.
- Paid hosting or setup. There is no commercial support.
