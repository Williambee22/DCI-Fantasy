# Security notes

- Use a unique production `SESSION_SECRET` of at least 32 random bytes.
- Remove `ADMIN_BOOTSTRAP_PASSWORD` after the initial administrator account is created.
- Keep PostgreSQL private to the Railway project unless external access is required.
- Review admin membership before publishing scores.
- The application does not store payment data.
- Automated third-party imports should remain disabled until authorization and source terms are confirmed.
