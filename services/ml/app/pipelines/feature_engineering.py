from dataclasses import dataclass
from typing import Tuple
import pandas as pd


@dataclass(frozen=True)
class ChronologicalSplit:
    train_df: pd.DataFrame
    test_df: pd.DataFrame


def chronological_split(
    df: pd.DataFrame,
    date_col: str,
    cutoff_iso: str,
) -> ChronologicalSplit:
    """
    Splits cricket match/ball-by-ball records strictly by timestamp to prevent future data leakage.
    """
    ordered = df.sort_values(date_col).copy()
    cutoff = pd.Timestamp(cutoff_iso)
    train_df = ordered[pd.to_datetime(ordered[date_col]) < cutoff]
    test_df = ordered[pd.to_datetime(ordered[date_col]) >= cutoff]
    return ChronologicalSplit(train_df=train_df, test_df=test_df)


def compute_phase_label(over_number: int) -> str:
    """Maps 1-based T20 over number to powerplay, middle, or death phase."""
    if over_number <= 6:
        return "powerplay"
    if over_number <= 15:
        return "middle"
    return "death"
