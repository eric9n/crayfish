# Quick install (copy/paste)

## Install

```bash
git clone https://github.com/eric9n/crayfish.git
cd crayfish
openclaw plugins install .
openclaw plugins enable crayfish
openclaw gateway restart
```

## Verify

```bash
openclaw plugins list
openclaw plugins info crayfish
openclaw plugins doctor
```

## Update (if installed via clone+link)

```bash
cd crayfish
git pull
openclaw gateway restart
```
