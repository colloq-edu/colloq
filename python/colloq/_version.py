# Версия пакета для hatchling: pyproject.toml берёт версию колеса отсюда.
# Число поднимает release-please в PR выпуска (по пометке в конце строки),
# а scripts/pack.mts переписывает файл тем же текстом при упаковке. Руками
# не править: `make version` сверяет число с корневым package.json.
__version__ = "0.1.0"  # x-release-please-version
