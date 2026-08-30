# Changelog

## [1.4.0](https://github.com/daordonez/gfotos-exporter/compare/gfotos-migrator-v1.3.0...gfotos-migrator-v1.4.0) (2026-08-30)


### Features

* durable upgrade path for all deployed TUI versions ([1df6c9b](https://github.com/daordonez/gfotos-exporter/commit/1df6c9bb5be75ce2c1c640aa562c55edf85c282a))
* durable upgrade path for all deployed TUI versions ([cb2bfdf](https://github.com/daordonez/gfotos-exporter/commit/cb2bfdff84b2dcf99685079e7a175448ef52101b))


### Bug Fixes

* handle component-scoped tags (gfotos-migrator-vX.Y.Z) in updater and installer ([2fa7491](https://github.com/daordonez/gfotos-exporter/commit/2fa7491f93e5f416f6f6b34dc5ff8b46cc294bcc))

## [1.3.0](https://github.com/daordonez/gfotos-exporter/compare/gfotos-migrator-v1.2.1...gfotos-migrator-v1.3.0) (2026-08-30)


### Features

* verify active CLI version after installer upgrades ([42c7a03](https://github.com/daordonez/gfotos-exporter/commit/42c7a033c6e7549ea13fe4cd5cd103aa8ae97c63))

## [1.2.1](https://github.com/daordonez/gfotos-exporter/compare/gfotos-migrator-v1.2.0...gfotos-migrator-v1.2.1) (2026-08-30)


### Bug Fixes

* defer node:sqlite import to suppress startup ExperimentalWarning ([fbd2678](https://github.com/daordonez/gfotos-exporter/commit/fbd26781eb31fbe5f3f64985aabe298dd9772d98))

## [1.2.0](https://github.com/daordonez/gfotos-exporter/compare/gfotos-migrator-v1.1.0...gfotos-migrator-v1.2.0) (2026-08-29)


### Features

* Auto-discover and select external storage after inventory ([51c7bda](https://github.com/daordonez/gfotos-exporter/commit/51c7bda26f23e58e80f1602ce29489a65e52d311))


### Bug Fixes

* Use cached volume state when navigating back from disk selection ([6a7a8d1](https://github.com/daordonez/gfotos-exporter/commit/6a7a8d1763c516aa4f6395c65e27a8e3a519247f))

## [1.1.0](https://github.com/daordonez/gfotos-exporter/compare/gfotos-migrator-v1.0.0...gfotos-migrator-v1.1.0) (2026-08-29)


### Features

* add guided self-update ([bcabb03](https://github.com/daordonez/gfotos-exporter/commit/bcabb03073cae02c0188bcccff9cb7fe1510b32f))
* add public TUI self-updates ([f6acd90](https://github.com/daordonez/gfotos-exporter/commit/f6acd90192fe12cfd6c94dfd5b564901ba58795c))
* support public release distribution ([f53a7b1](https://github.com/daordonez/gfotos-exporter/commit/f53a7b1fe92be3685455cf81fd1165b4dd3709a6))

## 1.0.0 (2026-08-29)


### Features

* add gfotos-migrator CLI tool for Google Takeout migration ([bcae045](https://github.com/daordonez/gfotos-exporter/commit/bcae045b998dfc66dfdd57888a2403e3f138a4a7))
* add guided GitHub release installer ([133d0da](https://github.com/daordonez/gfotos-exporter/commit/133d0da95e84c5d1d889990c732182a42e628d42))
* add guided GitHub release installer ([f5e2a96](https://github.com/daordonez/gfotos-exporter/commit/f5e2a96b93b2c15e9124a9df7cf613f15d3c657d))
* format selected external volumes as APFS ([27dbd47](https://github.com/daordonez/gfotos-exporter/commit/27dbd47b504b5d435ce646f596c8d29b51fb6e90))
* guide external migration storage setup ([3dda08d](https://github.com/daordonez/gfotos-exporter/commit/3dda08db30dd99915b7f820ef81fcd11f40a1781))
* list eligible external migration volumes ([c72a525](https://github.com/daordonez/gfotos-exporter/commit/c72a525f49924fd6aa3a5c0560e9ef8a43ad61d5))
* select and format external migration volumes ([f3ecf28](https://github.com/daordonez/gfotos-exporter/commit/f3ecf28eda6c10406496a0e40120e263c102189f))
* select release during installation ([75a4cd8](https://github.com/daordonez/gfotos-exporter/commit/75a4cd8c36f30051e44e06e0b50be6cd9cade856))
* select release during installation ([5477d42](https://github.com/daordonez/gfotos-exporter/commit/5477d42ccb00a7caa33f1937967f259f362eaa60))


### Bug Fixes

* confirm interactive token input ([e935521](https://github.com/daordonez/gfotos-exporter/commit/e935521ddd3f563329b69c7d305801b232060772))
* confirm interactive token input ([aae1492](https://github.com/daordonez/gfotos-exporter/commit/aae14924b912b48a33875d0e0e6fcf044215e1d3))
* disable implicit package manager cache ([c1eb923](https://github.com/daordonez/gfotos-exporter/commit/c1eb9239f35b287fed61f68f292c3f44425b8e77))
* download private release assets through API ([8930e81](https://github.com/daordonez/gfotos-exporter/commit/8930e81bff194b56673738f8a0be2a90f602347c))
* initialize pnpm after Node setup ([3b86a13](https://github.com/daordonez/gfotos-exporter/commit/3b86a13b9ac9d7b31aca23aebe3bd29a66f62abe))
* install pinned pnpm in workflows ([b0d5ddd](https://github.com/daordonez/gfotos-exporter/commit/b0d5dddb0eae2ce8c638a5d558f78b9a422b51b2))
* show token mask during interactive input ([b7aaed6](https://github.com/daordonez/gfotos-exporter/commit/b7aaed6c731dcfa8dd7de2d227164243ac39ddac))
