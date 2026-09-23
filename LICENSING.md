# Licensing

**AstroBaaS is free software under the GNU General Public License, version 3 or
later** (`GPL-3.0-or-later`). The full text is in [LICENSE](./LICENSE).

## What you may do

Everything the GPL grants, for any purpose, commercial included:

- **Run it.** Any number of installs, any number of shops, no fee, no key, no
  registration. There is no licence check anywhere in this codebase.
- **Read and change it.** It is your copy.
- **Redistribute it**, modified or not — including selling it — provided you
  pass on the same freedoms and make the corresponding source available to the
  people you distribute to, under the GPL.

Nobody has to ask permission, and nobody can take those rights away.

## What runs your site is yours

Running AstroBaaS to serve your own shop is not distribution. Your content, your
customisations and your data are yours, and nothing here reports home.

## Paid modules

What is sold separately sits one level up from the core, at the **vertical**: a
theme and the plugins that go with it, built for one trade — optical and eyewear
stores (prescriptions, dioptres, lens configuration), hotels and short stays,
restaurants, and more trades over time. None of them is on sale yet, and none of
them is in this repository; the core carries only the plugin seams such a module
loads through.

Three rules hold, and they are constraints on the project, not promises of good
behaviour:

- **The core behaves identically without them.** A feature that only makes sense
  in a paid module never removes something from the core to create the gap.
- **No licence check on the request path.** A shop's uptime must never depend on
  a licence server being reachable. If a check ever exists at all, it fails
  open.
- **No installation is ever gated.** Nothing in this repository refuses to run.

When one exists, you buy it and install it like any other plugin. If you do not
want it, you still have a complete, working CMS and commerce backend.

## Contributing

Contributors sign a CLA ([CLA.md](./CLA.md)) before their first change is
merged. It grants the project's owner a licence to use contributions under any
terms, including in the paid modules. It is a real asymmetry and the CLA says so
plainly, alongside the reason: one copyright holder is what makes the paid
modules — and therefore the funding for this work — possible.

What it does **not** do, and the CLA is explicit about each:

- it does not take your copyright — you keep it;
- it does not restrict what you do with your own contribution, including using
  it elsewhere, selling it, or giving it to a competitor of this project;
- it contains no non-compete.

If you would rather not sign, say so and open an issue describing the change
instead. It will be implemented independently and you will be credited.

## Third-party plugins and themes

Whether a plugin that runs inside a GPL host is a derivative work of it is an
unsettled question, argued in good faith on both sides for two decades. **This
project takes no position and asserts nothing against plugin authors.** If it
matters to your business, get your own advice.

## Dependencies

Runtime dependencies are permissive (MIT, ISC, Apache-2.0, BSD), with the
exceptions and the obligations they carry listed in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md). `npm run audit:licenses`
checks the production tree on every pull request, so a copyleft dependency
cannot arrive unnoticed.

## The name

"AstroBaaS" is the project's name. The GPL covers the code, not the name: a fork
is free to exist and free to compete, under a name of its own.

---

*This page describes how the project is licensed. It is not legal advice.*
