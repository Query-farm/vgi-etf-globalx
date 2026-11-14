"""Presentation helpers for the current holdings concentration example."""

from pathlib import Path

import matplotlib.pyplot as plt
import seaborn as sns
from IPython.display import Markdown, display

COLORS = {"QYLD": "#26765e", "XYLD": "#4e729e"}


def theme() -> None:
    """Apply readable shared chart settings."""
    sns.set_theme(style="whitegrid", context="notebook", font="DejaVu Sans")
    plt.rcParams.update(
        {"figure.dpi": 130, "text.parse_math": False, "axes.spines.top": False, "axes.spines.right": False}
    )


def prose(text: str) -> None:
    """Display result-derived Markdown."""
    display(Markdown(text))


def finish(fig: plt.Figure, title: str, subtitle: str, filename: str) -> None:
    """Add source context and save the chart for review."""
    fig.suptitle(title, x=0.07, y=0.98, ha="left", fontsize=18, weight="bold", color="#253d31")
    fig.text(0.07, 0.925, subtitle, fontsize=10.5, color="#52675a")
    fig.text(
        0.07,
        0.025,
        "Source: Global X current holdings CSVs · real vgi-etf-globalx v0.4.0 through Haybarn / VGI\n"
        "Concentration among positive reported weights; excludes negative and zero weights; not a risk measure",
        fontsize=9,
        color="#52675a",
    )
    directory = Path("validation/charts")
    directory.mkdir(parents=True, exist_ok=True)
    fig.savefig(directory / filename, dpi=150)
    plt.show()
