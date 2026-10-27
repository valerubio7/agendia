# Login entrances

- `/login` is the customer (business user) entrance.
- `/admin/login` is the administrator entrance, identified by “Acceso de administración”.
- `/` keeps the existing login page for compatibility with bookmarks and callers.

All three reuse `LivePanel` in `login` mode, `LoginScreen`, and `api.login`.
The server-returned role still determines the destination: platform administrators
reach `/businesses`; business users reach `/profile`. Valid credentials work at
any entrance, regardless of role. These routes separate presentation, not authorization.

Administrator logout and recovery links from the admin panel return to
`/admin/login`. Business logout and recovery links keep their existing `/` target.
The administrator workspace remains at `/businesses`.

Authentication endpoints, session cookies, CSRF handling, passwords, and existing
role-based access controls are unchanged. No new authentication system or
security boundary is introduced.
