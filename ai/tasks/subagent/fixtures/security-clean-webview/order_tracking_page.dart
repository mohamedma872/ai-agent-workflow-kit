import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import '../browser/external_browser.dart';
import '../session/session_store.dart';

const _trustedHosts = {'www.example-shop.com', 'm.example-shop.com'};

bool _isTrusted(Uri uri) => uri.scheme == 'https' && _trustedHosts.contains(uri.host);

/// Order tracking is a storefront page. The token is attached only to exact,
/// https, allow-listed hosts; everything else opens in the system browser.
class OrderTrackingPage extends StatelessWidget {
  const OrderTrackingPage({super.key, required this.orderUrl});

  final Uri orderUrl;

  @override
  Widget build(BuildContext context) {
    if (!_isTrusted(orderUrl)) {
      return const Center(child: Text('This link cannot be opened.'));
    }
    return InAppWebView(
      initialSettings: InAppWebViewSettings(useShouldOverrideUrlLoading: true),
      initialUrlRequest: URLRequest(
        url: WebUri.uri(orderUrl),
        headers: {HttpHeaders.authorizationHeader: 'Bearer ${SessionStore.instance.accessToken}'},
      ),
      shouldOverrideUrlLoading: (controller, action) async {
        final next = action.request.url;
        if (next != null && _isTrusted(next)) return NavigationActionPolicy.ALLOW;
        if (next != null) await ExternalBrowser.open(next);
        return NavigationActionPolicy.CANCEL;
      },
    );
  }
}
