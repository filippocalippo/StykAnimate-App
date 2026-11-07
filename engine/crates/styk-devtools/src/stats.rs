//! Deterministic summary statistics; invalid or empty samples are errors.
use serde_json::{Value, json};
pub fn summary(samples: &[f64]) -> Result<Value, String> {
    if samples.is_empty()
        || samples.len() > 100_000
        || samples.iter().any(|x| !x.is_finite() || *x < 0.0)
    {
        return Err("expected 1..100000 finite nonnegative samples".into());
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let q = |p: f64| sorted[((sorted.len() as f64 * p).ceil() as usize).saturating_sub(1)];
    let mean = samples
        .iter()
        .map(|x| x / samples.len() as f64)
        .sum::<f64>();
    Ok(
        json!({"n":samples.len(),"mean":mean,"p50":q(0.5),"p95":q(0.95),"p99":q(0.99),"max":sorted.last()}),
    )
}
/// Refuse measurements that cannot support a comparison. Raw run samples stay in each profile.
pub fn compare(a: &Value, b: &Value) -> Result<Value, String> {
    for key in ["format", "scenario", "input_hash", "clock", "build_profile"] {
        if a.get(key).is_none() || a[key] != b[key] {
            return Err(format!("incomparable {key}"));
        }
    }
    for key in ["scenario_hash", "machine"] {
        if a.get(key) != b.get(key) {
            return Err(format!("incomparable {key}"));
        }
    }
    if a["build_profile"] != "release" || a["clock"] != "real" {
        return Err("comparison requires release builds and a real measurement clock".into());
    }
    if a["format"] != "stykprofile/1" {
        return Err("incomparable profile format".into());
    }
    let budget_missed = b
        .get("budgets")
        .and_then(Value::as_array)
        .is_some_and(|rows| rows.iter().any(|row| row["met"] == false));
    let samples = |v: &Value| -> Result<Vec<f64>, String> {
        let rows = v["samples_ms"].as_array().ok_or("missing samples_ms")?;
        if rows.len() < 3 || rows.len() > 32 {
            return Err("comparison needs 3..32 samples".into());
        }
        rows.iter()
            .map(|v| v.as_f64().ok_or_else(|| "invalid sample".into()))
            .collect()
    };
    let a = samples(a)?;
    let b = samples(b)?;
    let sa = summary(&a)?;
    let sb = summary(&b)?;
    let median = |values: &[f64]| -> f64 {
        let mut v = values.to_vec();
        v.sort_by(f64::total_cmp);
        v[(v.len() - 1) / 2] / 2.0 + v[v.len() / 2] / 2.0
    };
    let baseline = median(&a);
    let delta = median(&b) - baseline;
    let mad = median(&a.iter().map(|x| (x - baseline).abs()).collect::<Vec<_>>());
    let floor = 0.05f64.max(baseline * 0.03).max(3.0 * mad);
    let range = |v: &[f64]| {
        v.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            - v.iter().copied().fold(f64::INFINITY, f64::min)
    };
    let significant = if a.len() >= 5 && b.len() >= 5 {
        mann_whitney(&a, &b)? < 0.01
    } else {
        delta.abs() > range(&a).max(range(&b))
    };
    let changed = delta.abs() > floor && significant;
    Ok(
        json!({"a":sa,"b":sb,"delta_ms":delta,"floor_ms":floor,"regression":(changed && delta>0.0)||budget_missed,"budget_missed":budget_missed,"verdict":if budget_missed {"budget regression"} else if !changed {"within noise"} else if delta>0.0 {"regression"} else {"improvement"}}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quantiles_and_invalid_samples() {
        let s = summary(&[4.0, 1.0, 2.0, 3.0]).unwrap();
        assert_eq!(s["p50"], 2.0);
        assert_eq!(s["p95"], 4.0);
        assert_eq!(s["mean"], 2.5);
        assert!(summary(&[]).is_err());
        assert!(summary(&[f64::NAN]).is_err());
    }
    #[test]
    fn noise_floor_distinguishes_shifts() {
        let profile = |samples: Vec<f64>| json!({"format":"stykprofile/1","scenario":"open","input_hash":"test","clock":"real","build_profile":"release","samples_ms":samples});
        let baseline = profile(vec![99.0, 100.0, 101.0]);
        assert!(compare(&baseline, &profile(vec![100.0; 33])).is_err());
        let mut missed = baseline.clone();
        missed["budgets"] = json!([{"met":false}]);
        assert_eq!(
            compare(&baseline, &missed).unwrap()["verdict"],
            "budget regression"
        );
        assert_eq!(compare(&baseline, &missed).unwrap()["regression"], true);
        assert_eq!(
            compare(&baseline, &profile(vec![104.0, 105.0, 106.0])).unwrap()["regression"],
            true
        );
        assert_eq!(
            compare(&baseline, &profile(vec![101.0, 102.0, 103.0])).unwrap()["regression"],
            false
        );
    }
    #[test]
    fn quick_and_fixed_runs_are_not_measurements() {
        let v = json!({"format":"stykprofile/1","scenario":"open","input_hash":"test","clock":"fixed","build_profile":"quick","samples_ms":[1,2,3]});
        assert!(compare(&v, &v).is_err());
    }
}

/// Exact two-sided rank permutation probability, including tied observations.
/// The explicit diagnostic limit bounds the dynamic-programming workspace.
fn mann_whitney(a: &[f64], b: &[f64]) -> Result<f64, String> {
    if a.len() > 32 || b.len() > 32 {
        return Err("exact comparison supports at most 32 runs per side".into());
    }
    let mut pooled: Vec<_> = a
        .iter()
        .map(|v| (*v, true))
        .chain(b.iter().map(|v| (*v, false)))
        .collect();
    pooled.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut ranks = Vec::new();
    let mut observed = 0usize;
    let mut i = 0;
    while i < pooled.len() {
        let mut j = i + 1;
        while j < pooled.len() && pooled[j].0 == pooled[i].0 {
            j += 1;
        }
        let rank = i + 1 + j;
        for item in &pooled[i..j] {
            ranks.push(rank);
            if item.1 {
                observed += rank;
            }
        }
        i = j;
    }
    let max_sum = 2 * pooled.len() * a.len();
    let mut dp = vec![vec![0.0; max_sum + 1]; a.len() + 1];
    dp[0][0] = 1.0;
    for (index, rank) in ranks.into_iter().enumerate() {
        for n in (1..=a.len().min(index + 1)).rev() {
            for sum in (rank..=max_sum).rev() {
                dp[n][sum] += dp[n - 1][sum - rank];
            }
        }
    }
    let expected = a.len() * (pooled.len() + 1);
    let distance = observed.abs_diff(expected);
    let mut tail = 0.0;
    let mut total = 0.0;
    for (sum, count) in dp[a.len()].iter().enumerate() {
        total += count;
        if sum.abs_diff(expected) >= distance {
            tail += count;
        }
    }
    Ok(tail / total)
}
#[cfg(test)]
mod rank_tests {
    use super::*;
    #[test]
    fn exact_rank_probabilities() {
        assert!(
            (mann_whitney(&[1., 2., 3., 4., 5.], &[6., 7., 8., 9., 10.]).unwrap() - 2.0 / 252.0)
                .abs()
                < 1e-12
        );
        assert_eq!(mann_whitney(&[1.; 5], &[1.; 5]).unwrap(), 1.0);
    }
}
