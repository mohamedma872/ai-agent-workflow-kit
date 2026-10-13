import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import '../session/session_store.dart';

/// Help centre and CMS pages. Storefront links open in a new HelpWebPage so the
/// signed-in user stays signed in on the web side.
class HelpWebPage extends StatelessWidget {
  const HelpWebPage({super.key, required this.url});

  final String url;

  @override
  Widget build(BuildContext context) {
    final token = SessionStore.instance.accessToken;
    return InAppWebView(
      initialUrlRequest: URLRequest(
        url: WebUri(url),
        headers: {HttpHeaders.authorizationHeader: 'Bearer $token'},
      ),
      shouldOverrideUrlLoading: (controller, action) async {
        final next = action.request.url.toString();
        if (next.startsWith('https://www.example-shop.com')) {
          Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => HelpWebPage(url: next)),
          );
          return NavigationActionPolicy.CANCEL;
        }
        return NavigationActionPolicy.ALLOW;
      },
    );
  }
}
