# RUFocusing

A study-focus analysis project. This repository currently contains the project scaffold; application features are not implemented yet.

## Structure

```text
RUFocusing/
├── apps/
│   ├── desktop/
│   │   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   └── src-tauri/
│   └── vision/
│       ├── camera.py
│       ├── face.py
│       ├── gaze.py
│       ├── pose.py
│       ├── phone.py
│       └── worker.py
├── core/
│   ├── features/
│   │   ├── feature_engine.py
│   │   └── windows.py
│   ├── behavior/
│   │   ├── rules.py
│   │   └── classifier.py
│   ├── analytics/
│   │   ├── focus_blocks.py
│   │   ├── distractions.py
│   │   ├── recovery.py
│   │   └── insights.py
│   └── models/
├── extensions/
│   ├── chrome/
│   └── vscode/
├── database/
│   ├── schema.sql
│   └── migrations/
├── tests/
├── docs/
│   ├── architecture.md
│   └── privacy.md
├── README.md
└── LICENSE
```

The existing repository name is retained. Empty directories contain `.gitkeep` files so Git preserves the layout. Python modules and the database schema are placeholders.

## Documentation

- [Architecture](docs/architecture.md)
- [Privacy](docs/privacy.md)

## License

[Apache License 2.0](LICENSE).
