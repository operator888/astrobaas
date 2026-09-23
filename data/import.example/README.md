# Example WooCommerce import fixtures

Synthetic data for exercising `npm run import:woo`. Every person, address and
phone number here is invented, and every email uses an RFC 2606 reserved domain
(`example.com` / `example.org`) so it can never reach a real inbox.

```bash
npm run import:woo -- data/import.example
```

## Importing a real shop

Export your own store into a directory **outside version control** and point the
importer at it:

```bash
npm run import:woo -- /path/to/my-export
```

`data/import/` is gitignored for exactly this reason. A WooCommerce export
contains customer names, email addresses, phone numbers and street addresses —
personal data under GDPR, and a commit is forever. Keep it out of the repo.
