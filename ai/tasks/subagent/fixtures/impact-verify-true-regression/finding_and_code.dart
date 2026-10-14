// Impact-verification fixture. Fake code, not from any real project.
//
// FINDING UNDER VERIFICATION (claimed severity: high):
//   "Expired sessions are never logged out: HEAD reads errors[0].reason into a
//    non-nullable String, so the standard 401 body (no 'reason') throws inside
//    the 401 branch and logout() is skipped."
//
// The 401 body the backend sends: {"errors":[{"type":"InvalidTokenError","message":"Invalid access token"}]}

// ===== BASE (merge base) — base/lib/models/error_model.dart:70 =====
bool handle401Base(Map json) {
  try {
    final String? reason = json['errors'][0]['reason'];
    final String message = json['errors'][0]['message'] ?? '';
    if (message.contains('Invalid access token')) { logout(); return false; }
    return reason == 'expired';
  } catch (e) { return false; }
}

// ===== HEAD (branch) — head/lib/core/models/error_model.dart:81 =====
bool handle401Head(Map json) {
  try {
    final String reason = json['errors'][0]['reason'];
    final String message = json['errors'][0]['message'] ?? '';
    if (message.contains('Invalid access token')) { logout(); return false; }
    return reason == 'expired';
  } catch (e) { return false; }
}

// ===== PRODUCTION (origin/master) — lib/models/error_model.dart:70 is identical to BASE. =====
// No feature flag guards either version; handle401Head is called from every API response handler.

void logout() {}
