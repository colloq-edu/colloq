"""CPU smoke test for Colloq's lightweight kaggle-base image (no network)."""
import importlib.metadata as metadata
import json
import platform
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
import pyarrow as pa
import optuna
import shap
import statsmodels.api as sm
from catboost import CatBoostRegressor
from lightgbm import LGBMRegressor
from xgboost import XGBRegressor
from category_encoders import TargetEncoder
from imblearn.over_sampling import RandomOverSampler

rng = np.random.default_rng(42)
x = pd.DataFrame(rng.normal(size=(80, 4)), columns=list('abcd'))
y = 3 * x.a.to_numpy() + x.b.to_numpy() ** 2
models = {
    'catboost': CatBoostRegressor(iterations=8, depth=3, verbose=False, thread_count=1, allow_writing_files=False),
    'lightgbm': LGBMRegressor(n_estimators=8, num_leaves=7, min_child_samples=4, n_jobs=1, verbosity=-1),
    'xgboost': XGBRegressor(n_estimators=8, max_depth=3, n_jobs=1, tree_method='hist', device='cpu'),
}
for name, model in models.items():
    model.fit(x, y)
    prediction = model.predict(x.iloc[:5])
    assert prediction.shape == (5,) and np.isfinite(prediction).all(), name
values = shap.TreeExplainer(models['lightgbm']).shap_values(x.iloc[:4])
assert np.asarray(values).shape == (4, 4)
assert np.isfinite(values).all()
optuna.logging.set_verbosity(optuna.logging.ERROR)
study = optuna.create_study(sampler=optuna.samplers.RandomSampler(seed=42))
study.optimize(lambda trial: (trial.suggest_float('x', -1, 1) - .2) ** 2, n_trials=2)
assert len(study.trials) == 2
assert pl.from_pandas(x).shape == (80, 4)
assert pa.Table.from_pandas(x).num_rows == 80
encoded = TargetEncoder().fit_transform(pd.DataFrame({'city': ['a', 'b'] * 40}), y)
assert np.isfinite(encoded.to_numpy()).all()
_, labels = RandomOverSampler(random_state=42).fit_resample(x, [0] * 60 + [1] * 20)
assert len(labels) == 120
assert np.isfinite(sm.OLS(y, sm.add_constant(x)).fit().params).all()
assert sorted(p.name for p in Path('/sys/class/net').iterdir()) == ['lo']
packages = ['numpy', 'pandas', 'scipy', 'scikit-learn', 'catboost', 'lightgbm', 'xgboost', 'optuna', 'polars', 'pyarrow', 'statsmodels', 'imbalanced-learn', 'category-encoders', 'shap', 'h3', 'nbclient', 'nbformat']
print(json.dumps({'python': platform.python_version(), 'versions': {name: metadata.version(name) for name in packages}, 'checks': ['three boosters train/predict', 'SHAP', 'Optuna', 'Polars', 'Arrow', 'categorical encoding', 'resampling', 'statsmodels', 'network disabled']}, indent=2))
