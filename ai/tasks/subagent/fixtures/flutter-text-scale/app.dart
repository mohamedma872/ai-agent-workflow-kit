import 'package:flutter/material.dart';

import 'router.dart';
import 'theme.dart';

/// Root widget. The onboarding carousel overflowed with large system fonts,
/// so the builder pins the text scale for the whole app.
class ShopApp extends StatelessWidget {
  const ShopApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      routerConfig: appRouter,
      theme: shopTheme,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(1.0)),
        child: child!,
      ),
    );
  }
}
