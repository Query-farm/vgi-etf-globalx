# Global X: holdings count and concentration

[Open the executed example](01_holdings_count_and_concentration.ipynb). It compares
QYLD and XYLD using current issuer holdings, checks signed weights, and calculates
concentration among positive reported weights with visible SQL. Two charts show
the cumulative distribution and the contributors behind its head. This is a
descriptive data example, not an assessment of investment suitability or risk.

## Run from this directory

Install [uv](https://docs.astral.sh/uv/), then:

```bash
uv sync --frozen
uv run python execute.py
```

The locked environment uses Python 3.13–3.14 and published Haybarn 2.0.0rc11.
The visible SQL attaches `github-auto://Query-farm/vgi-etf-globalx@v0.4.0`;
Haybarn downloads the corresponding published native worker. No worker checkout,
Bun installation, API key, local worker build, or registered kernel is required.
Internet access to GitHub, the community extension repository, and Global X is
required. A fresh run retrieves live current files; it never substitutes fixtures.

To select this environment in a notebook editor:

```bash
uv run python -m ipykernel install --user --name globalx-examples \
  --display-name "Python (vgi-etf-globalx notebooks)"
```

Select that kernel, open the notebook, and restart/run all after changing its
visible `TOP_N` parameter. Setup and plotting source are folded; SQL remains
visible. Relative assets and helpers are bundled, so this directory also works
when copied outside the repository.

## Focused experiment

```bash
uv run python execute.py --parameters '{"TOP_N":20}' \
  --output-dir validation/top-20
```

The runner executes a fresh kernel and saves only after success. Overrides require
a separate destination, which receives branding and execution companions. The
default is `TOP_N = 10`; the accepted range is 5–30. More included positive rows
cannot reduce concentration for an unchanged snapshot. Check returned file dates
before attributing fresh-run changes to this cutoff; same-date revisions are
also possible.

## Source and interpretation

The real worker reads the [Global X catalog](https://www.globalxetfs.com/explore)
and current holdings CSVs for [QYLD](https://www.globalxetfs.com/funds/qyld/) and
[XYLD](https://www.globalxetfs.com/funds/xyld/). Each selected fund is materialized
once for reuse. The notebook displays source dates and a UTC retrieval clock;
separate responses are not an atomic snapshot and the worker has no historical
as-of selector. Live availability and issuer format changes can stop execution.

`weight_percent` is in percentage points of reported net assets. Availability
diagnostics retain missing, zero, negative and positive rows separately. The
charts normalize only positive reported weights to 100%; negative weights are
excluded from that denominator, not replaced with zero. This is not a measure of
option notional exposure, delta, correlation or portfolio risk. Security rows
remain separate, including different share classes of one issuer.

The saved outputs are a dated example, not a guaranteed current result. To update
the worker, edit its literal SQL release pin and rerun both the default and
experiment against the locked engine. [STANDARD.md](STANDARD.md) records the
notebook presentation and execution conventions.
