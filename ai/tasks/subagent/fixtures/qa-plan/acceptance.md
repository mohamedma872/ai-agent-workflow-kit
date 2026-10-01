# PROJ-412 — Session refresh

**Requirement:** When the access token expires, the app silently refreshes it using the stored
refresh token and retries the original request once. If refresh is not possible, the user is
signed out and returned to the login screen with the message "Your session has ended".

## Planned tests

1. Valid access token → API request succeeds, no refresh call made.
2. Expired access token + valid refresh token → one refresh call, original request retried once, succeeds.
3. Refresh succeeds → new tokens are persisted in secure storage.
