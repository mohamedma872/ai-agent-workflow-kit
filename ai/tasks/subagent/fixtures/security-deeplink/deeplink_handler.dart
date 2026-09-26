import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'auth/session.dart';

/// Handles myapp://login-complete?redirect=<url>&token=<jwt> from the web sign-in flow.
Future<void> handleDeepLink(BuildContext context, Uri uri) async {
  if (uri.host == 'login-complete') {
    final token = uri.queryParameters['token'];
    if (token != null) {
      await Session.instance.signInWithToken(token);
    }
    final redirect = uri.queryParameters['redirect'];
    if (redirect != null) {
      await launchUrl(Uri.parse(redirect), mode: LaunchMode.inAppWebView);
    }
  }
}
