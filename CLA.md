# AstroBaaS Contributor License Agreement

**Version 1.0 — effective 2026-08-10**

Thank you for contributing to AstroBaaS.

This Agreement sets out the terms under which You contribute code, documentation
or other material to the Project. It is signed **once**, and it then covers every
contribution You make afterwards.

Please read [Why this exists](#why-this-exists) at the end before deciding how
you feel about it. It is a short, honest explanation rather than a sales pitch,
and it names what You give up as well as what You keep.

> **Not legal advice.** This document was drafted by the Project owner, who is
> not a lawyer. It follows the structure of the Apache Software Foundation's
> Individual Contributor License Agreement v2.0, which most contributor
> agreements derive from. If You are contributing on behalf of an employer, or
> if anything here matters to You commercially, have Your own counsel read it.

---

## Definitions

- **"Owner"** means Theodor Dimitriou, the sole copyright holder of the Project.
- **"Project"** means AstroBaaS, in the repository this file lives in and any
  successor to it.
- **"You"** means the individual accepting this Agreement, or the legal entity
  on whose behalf it is accepted. For a legal entity, "You" includes any entity
  that controls, is controlled by, or is under common control with it.
- **"Contribution"** means any original work of authorship — including any
  modification of or addition to an existing work — that You intentionally
  submit to the Project. "Submit" means any form of communication sent to the
  Owner or the Project's repositories, issue trackers or mailing lists, but
  excludes anything conspicuously marked **"Not a Contribution."**

---

## 1. You keep your copyright

**You retain all right, title and interest in and to Your Contributions.**

Nothing in this Agreement assigns or transfers ownership of Your copyright to
the Owner. You remain free to use, publish, license and sell Your own
Contribution however You wish, to anyone, including to competitors of the
Project. This Agreement grants a licence; it does not take anything away from
You.

## 2. Copyright licence You grant

You grant the Owner a perpetual, worldwide, non-exclusive, no-charge,
royalty-free and **irrevocable** copyright licence to reproduce, prepare
derivative works of, publicly display, publicly perform, sublicense and
distribute Your Contributions and such derivative works.

**This licence is granted under any licence terms the Owner chooses**, including
without limitation open source licences and proprietary or commercial licences.

You acknowledge that the Owner may distribute the Project, including Your
Contribution, under terms different from those under which You submitted it —
including as part of a paid, closed-source edition or module — and may do so
without further notice to You and without any obligation to pay You.

## 3. Patent licence You grant

You grant the Owner a perpetual, worldwide, non-exclusive, no-charge,
royalty-free and irrevocable (except as stated below) patent licence to make,
have made, use, offer to sell, sell, import and otherwise transfer the
Contribution and the Project. This licence applies only to those patent claims
You can license that are necessarily infringed by Your Contribution alone, or by
the combination of Your Contribution with the Project.

If any entity institutes patent litigation alleging that the Project or a
Contribution constitutes direct or contributory patent infringement, any patent
licences granted under this Agreement to that entity terminate as of the date
such litigation is filed.

## 4. What the Owner promises in return

These are commitments to You, not boilerplate:

1. **Your Contribution stays open.** Every Contribution merged into the
   open-source Project will remain available under a licence approved by the
   [Open Source Initiative](https://opensource.org/licenses). The Owner may
   *additionally* license it commercially; the Owner will not *withdraw* it from
   the open-source edition.
2. **Attribution is preserved.** Your authorship in the Git history and in any
   file-level notices is not removed or rewritten.
3. **The grant is not exclusive.** Because You keep Your copyright (§1), nothing
   here stops You doing anything at all with Your own work.

## 5. What You represent

You represent that:

1. **You have the right to grant this licence.** Each Contribution is either
   Your original creation, or You have sufficient rights in it to grant the
   licences above.
2. **Your employer, if any, has no conflicting claim.** If Your employer has
   rights to intellectual property You create — which is common in employment
   contracts — You represent that You have received permission to make the
   Contribution on behalf of that employer, that Your employer has waived such
   rights, or that Your employer has executed a separate agreement with the
   Owner.
3. **You have identified third-party material.** If You submit work that is not
   Your original creation, You will submit it separately from any Contribution,
   identify its source and any licence or other restriction You are aware of,
   and mark it conspicuously as **"Submitted on behalf of a third party:
   [named here]."**

## 6. No obligation, no warranty

The Owner is under no obligation to accept, merge, use or maintain any
Contribution. The decision to include a Contribution in the Project rests
entirely with the Owner.

Unless required by applicable law or agreed to in writing, You provide Your
Contributions **"AS IS", without warranties or conditions of any kind**, either
express or implied, including without limitation any warranty of title,
non-infringement, merchantability or fitness for a particular purpose.

## 7. Tell us if something changes

You agree to notify the Owner if any fact or representation You have relied on
in this Agreement later becomes inaccurate — for example, if You discover that a
Contribution included third-party code You were not aware of.

## 8. Governing law

This Agreement is governed by the laws of the **Federal Republic of Germany**,
excluding its conflict-of-law rules, with the courts of **Augsburg, Bayern**
having jurisdiction.

---

## How to sign

**You do not need to do anything in advance.** Open Your pull request as normal.
A bot will comment on it asking You to sign, and You sign by posting **exactly**
this sentence as a new comment on that pull request:

> I have read the CLA Document and I hereby sign the CLA

That is the whole process, and it happens once — later pull requests are not
gated again. The bot matches that sentence literally, so paste it rather than
paraphrasing it.

Signatures are recorded in a separate repository, not in this one, so a change
of signature status never appears as a code change.

If You would rather sign out of band, email
**theodoros@ecommercewebservices.de** with the subject `CLA` and the sentence
"I have read the AstroBaaS CLA v1.0 and I agree to it", from the email address
associated with Your GitHub account.

---

## Why this exists

Being direct about this, because a CLA is the sort of thing that quietly annoys
people when it appears without explanation.

AstroBaaS is GPL-3.0 and will stay that way. It is funded by selling *modules*
that sit on top of it — the optical/eyewear vertical first. That business model
only works while one person holds the copyright to the core, because a licence
binds everyone who receives the code except its author.

The moment an outside contribution lands without an agreement like this one, the
Project can no longer be dual-licensed, and the funding model dies with it. Not
because anyone did anything wrong — that is simply how copyright works when a
work has more than one author.

So the trade is:

- **You give up:** the ability to stop the Owner from selling something that
  includes Your contribution.
- **You keep:** Your copyright, Your attribution, Your freedom to do anything
  else with Your own code, and a guarantee (§4.1) that Your work stays in the
  open-source edition.

Some developers refuse to sign CLAs on principle, and that is a coherent
position — Linux uses a Developer Certificate of Origin precisely to avoid this
asymmetry, and as a direct result Linux can never be dual-licensed by anyone.
That is the same trade seen from the other side. If You would rather not sign,
that is genuinely fine: open an issue instead, and the Owner will implement the
idea independently.

The same instrument is used by Apache Software Foundation projects, Google,
Elastic, MongoDB, GitLab, Qt and — the direct model for this Project — Magento.

Longer reasoning, including why the Project chose this over a DCO, is in
[LICENSING.md](./LICENSING.md).
