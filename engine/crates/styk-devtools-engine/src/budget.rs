//! Scenario budgets judge the median of independent runs, never a tuned tolerance.
use serde_json::{Value, json};
#[derive(Clone, Debug)]
pub struct Budget {
    pub metric: String,
    pub op: String,
    pub limit: f64,
    pub unit: String,
    pub line: usize,
    pub floor: Option<String>,
}
impl Budget {
    pub fn parse(text: &str, line: usize) -> Result<Self, String> {
        let (text, floor) = text
            .split_once(" floor:")
            .map_or((text, None), |(a, b)| (a, Some(b.trim().to_owned())));
        let fields: Vec<_> = text.split_whitespace().collect();
        let ["budget", metric, op, quantity] = fields.as_slice() else {
            return Err(format!("invalid budget at line {line}"));
        };
        if metric.len() > 128
            || !metric
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_')
            || !["<=", ">=", "==", "<", ">"].contains(op)
            || floor.as_ref().is_some_and(|s| s.len() > 512)
        {
            return Err(format!("invalid budget at line {line}"));
        }
        let (number, unit, multiplier) = [
            ("MiB", 1048576.),
            ("KiB", 1024.),
            ("ms", 1.),
            ("s", 1000.),
            ("B", 1.),
            ("%", 1.),
        ]
        .into_iter()
        .find_map(|(u, m)| quantity.strip_suffix(u).map(|n| (n, u, m)))
        .unwrap_or((quantity, "", 1.));
        let limit = number
            .parse::<f64>()
            .map_err(|_| format!("invalid budget value at line {line}"))?
            * multiplier;
        if !limit.is_finite() || limit < 0. {
            return Err("budget must be finite and nonnegative".into());
        }
        Ok(Self {
            metric: (*metric).into(),
            op: (*op).into(),
            limit,
            unit: unit.into(),
            line,
            floor,
        })
    }
    pub fn judge(&self, runs: &[Value]) -> Result<Value, String> {
        if runs.is_empty() || runs.len() > 32 {
            return Err("budgets need 1..32 runs".into());
        }
        let mut samples = Vec::with_capacity(runs.len());
        for run in runs {
            let mut value = run;
            for field in self.metric.split('.') {
                value = value.get(field).ok_or_else(|| {
                    format!(
                        "budget metric unavailable: {} (line {})",
                        self.metric, self.line
                    )
                })?;
            }
            samples.push(
                value
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or("budget metric is not finite numeric data")?,
            );
        }
        samples.sort_by(f64::total_cmp);
        let median = samples[(samples.len() - 1) / 2] / 2. + samples[samples.len() / 2] / 2.;
        let met = match self.op.as_str() {
            "<=" => median <= self.limit,
            ">=" => median >= self.limit,
            "==" => median == self.limit,
            "<" => median < self.limit,
            ">" => median > self.limit,
            _ => return Err("invalid budget operator".into()),
        };
        Ok(
            json!({"metric":self.metric,"op":self.op,"limit":self.limit,"unit":self.unit,"median":median,"runs":runs.len(),"met":met,"line":self.line,"floor":self.floor}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn median_units_and_missing_metrics_are_not_silent() {
        let b = Budget::parse("budget start.usable <= 0.5s", 3).unwrap();
        assert_eq!(b.limit, 500.);
        let rows = [
            json!({"start":{"usable":1}}),
            json!({"start":{"usable":600}}),
            json!({"start":{"usable":800}}),
        ];
        assert_eq!(b.judge(&rows).unwrap()["met"], false);
        assert!(b.judge(&[json!({})]).is_err());
        assert!(Budget::parse("budget a <= NaNms", 2).is_err());
        assert_eq!(
            Budget::parse("budget memory.rss <= 2MiB", 2).unwrap().limit,
            2097152.
        );
    }
}
