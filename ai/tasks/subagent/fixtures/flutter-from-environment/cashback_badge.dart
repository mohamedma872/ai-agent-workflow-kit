import 'package:flutter/material.dart';
import 'package:flutter_html/flutter_html.dart';

/// Renders the CMS cashback tag "label|status|htmlEnabled|color" on product tiles.
class CashbackBadge extends StatelessWidget {
  const CashbackBadge({super.key, required this.cmsTag});

  final String cmsTag;

  @override
  Widget build(BuildContext context) {
    final parts = cmsTag.split('|');
    final label = parts[0];
    final htmlEnabled = parts[2].isNotEmpty ? bool.fromEnvironment(parts[2]) : false;
    final color = Color(int.parse(parts[3], radix: 16));
    return Container(
      color: color,
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      child: htmlEnabled ? Html(data: label) : Text(label),
    );
  }
}
