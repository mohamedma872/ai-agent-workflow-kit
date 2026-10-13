import 'dart:async';

import 'package:flutter/material.dart';

import 'search_repository.dart';

/// Search box with a debounced suggestion request.
class SearchField extends StatefulWidget {
  const SearchField({super.key, required this.repository});

  final SearchRepository repository;

  @override
  State<SearchField> createState() => _SearchFieldState();
}

class _SearchFieldState extends State<SearchField> {
  final _controller = TextEditingController();
  Timer? _debounce;
  List<String> _suggestions = const [];

  void _onChanged(String query) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      final result = await widget.repository.suggestions(query);
      if (!mounted) return;
      setState(() => _suggestions = result);
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        TextField(
          controller: _controller,
          onChanged: _onChanged,
          decoration: const InputDecoration(labelText: 'Search'),
        ),
        for (final s in _suggestions) ListTile(title: Text(s)),
      ],
    );
  }
}
