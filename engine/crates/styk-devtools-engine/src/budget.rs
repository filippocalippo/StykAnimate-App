//! Scenario budgets judge the median of independent runs, never a tuned tolerance.
use serde_json::{Value, json};
#[derive(Clone, Debug)]
pub struct Budget {
    pub spec: styk_core::automation::BudgetSpec,
    pub line: usize,
}
impl Budget {
    pub fn judge(&self, runs: &[Value]) -> Result<Value, String> {
        if runs.is_empty() || runs.len() > 32 {
            return Err("budgets need 1..32 runs".into());
        }
        let mut samples = Vec::with_capacity(runs.len());
        for run in runs {
            let mut value = run;
            for field in self.spec.metric.split('.') {
                value = value.get(field).ok_or_else(|| {
                    format!(
                        "budget metric unavailable: {} (line {})",
                        self.spec.metric, self.line
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
        let met = match self.spec.op.as_str() {
            "<=" => median <= self.spec.limit,
            ">=" => median >= self.spec.limit,
            "==" => median == self.spec.limit,
            "<" => median < self.spec.limit,
            ">" => median > self.spec.limit,
            _ => return Err("invalid budget operator".into()),
        };
        Ok(
            json!({"metric":self.spec.metric,"op":self.spec.op,"limit":self.spec.limit,"unit":self.spec.unit,"median":median,"runs":runs.len(),"met":met,"line":self.line,"floor":self.spec.floor}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn parsed_budget(text: &str, line: usize) -> Result<Budget, String> {
        let script = styk_core::automation::Script::parse(&format!("{}{text}", "\n".repeat(line - 1))).map_err(|e| e.to_string())?;
        crate::scenario::budgets(&script)?.into_iter().next().ok_or("missing budget".into())
    }
    #[test]
    fn median_units_and_missing_metrics_are_not_silent() {
        let b = parsed_budget("budget start.usable <= 0.5s", 3).unwrap();
        assert_eq!(b.spec.limit, 500.);
        let rows = [
            json!({"start":{"usable":1}}),
            json!({"start":{"usable":600}}),
            json!({"start":{"usable":800}}),
        ];
        assert_eq!(b.judge(&rows).unwrap()["met"], false);
        assert!(b.judge(&[json!({})]).is_err());
        assert!(parsed_budget("budget a <= NaNms", 2).is_err());
        assert_eq!(
            parsed_budget("budget memory.rss <= 2MiB", 2).unwrap().spec.limit,
            2097152.
        );
    }
}
