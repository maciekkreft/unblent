# Contributing to Unblent

Thank you for helping. Unblent is licensed under the MIT License (see [LICENSE](LICENSE));
anything you contribute is licensed the same way.

## Report a problem or suggest something

- **Something is not working:** open an issue with the
  [bug form](https://github.com/maciekkreft/unblent/issues/new?template=bug.yml). It asks
  what happened, what you expected, your Unblent version (Unblent › About Unblent) and
  your macOS version.
- **You wish Unblent could do something:** use the
  [wish form](https://github.com/maciekkreft/unblent/issues/new?template=feature.yml), or
  post it in [Discussions › Ideas](https://github.com/maciekkreft/unblent/discussions/categories/ideas),
  where others can vote for the ideas they want most.
- **A question:** ask in
  [Discussions › Q&A](https://github.com/maciekkreft/unblent/discussions/categories/q-a).

## Run it from source

You need Python 3 (the app is built with Python 3.14). From the repository folder:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python mac/serve.py
```

Then open the address it prints, `http://127.0.0.1:47321/workshop/apps/macapp`, in a
browser. This is the same server and page the Mac app shows. On a Mac it uses the same
data folder as the app, `~/Library/Application Support/Unblent`, and the same port, so
quit the app first. To keep your own books apart, set another folder with
`UNBLENT_DATA=/some/folder`.

To build the Mac app itself, on a Mac with Apple Silicon run `bash mac/build-local.sh`.
It installs what is missing with Homebrew and prints where `Unblent.dmg` is.
[mac/RELEASING.md](mac/RELEASING.md) explains how releases are made.

`python3 checks/check.py --help` lists the checks and when to run them.

## Changing the design

[architecture.md](architecture.md) is the specification: it holds the design decisions
and the rules every part must keep, and the checks enforce them. A change that keeps
the rules can be proposed as a pull request. A change to architecture.md itself, or
one that needs a new rule, is discussed first: open an issue or a discussion that says
what you want to change and why, before writing code.
