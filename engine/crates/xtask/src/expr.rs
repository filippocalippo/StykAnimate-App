//! CSS length expressions (`max()`, `min()`, `clamp()`, `calc()`) as Rust functions.
//!
//! A token such as `--topbar-h: max(52px, calc(44px / var(--ui-scale)))` is not a constant: it depends on a property
//! the page sets at run time. The generator keeps those properties (`tokens::RUNTIME_INPUTS`) as `var()` references,
//! parses the expression here, and emits `pub fn topbar_h(ui_scale: f32) -> f32`, with one `f32` parameter per run-time
//! property, in order of first use. Only lengths in `px` and plain numbers are understood; anything else is an error
//! the caller reports, never silently dropped.

#[derive(Debug, PartialEq)]
enum Expr {
    Number(f64),
    Param(String),
    Binary(Box<Expr>, char, Box<Expr>),
    Call(Function, Vec<Expr>),
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum Function {
    Max,
    Min,
    Clamp,
    Calc,
}

/// A parsed expression ready to print.
#[derive(Debug, PartialEq)]
pub struct Parsed {
    expression: Expr,
    /// The run-time properties it reads (`--ui-scale`), in order of first use.
    pub params: Vec<String>,
}

pub fn is_expression(text: &str) -> bool {
    ["max(", "min(", "clamp(", "calc("].iter().any(|prefix| text.starts_with(prefix))
}

pub fn parse(text: &str) -> Result<Parsed, String> {
    let mut parser = Parser { text: text.as_bytes(), at: 0, params: Vec::new() };
    let expression = parser.expression()?;
    parser.skip_space();
    if parser.at != parser.text.len() {
        return Err(format!("unexpected {:?} in {text:?}", &text[parser.at..]));
    }
    Ok(Parsed { expression, params: parser.params })
}

struct Parser<'a> {
    text: &'a [u8],
    at: usize,
    params: Vec<String>,
}

impl Parser<'_> {
    fn skip_space(&mut self) {
        while self.text.get(self.at).is_some_and(u8::is_ascii_whitespace) {
            self.at += 1;
        }
    }

    fn eat(&mut self, byte: u8) -> bool {
        self.skip_space();
        if self.text.get(self.at) == Some(&byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn rest(&self) -> &str {
        std::str::from_utf8(&self.text[self.at..]).unwrap_or("")
    }

    fn expression(&mut self) -> Result<Expr, String> {
        let mut left = self.term()?;
        loop {
            self.skip_space();
            let operator = match self.text.get(self.at) {
                Some(b'+') => '+',
                // A minus is an operator only with space around it, as CSS requires; `-4px` is a number.
                Some(b'-') if self.text.get(self.at + 1) == Some(&b' ') => '-',
                _ => return Ok(left),
            };
            self.at += 1;
            left = Expr::Binary(Box::new(left), operator, Box::new(self.term()?));
        }
    }

    fn term(&mut self) -> Result<Expr, String> {
        let mut left = self.factor()?;
        loop {
            let operator = if self.eat(b'*') {
                '*'
            } else if self.eat(b'/') {
                '/'
            } else {
                return Ok(left);
            };
            left = Expr::Binary(Box::new(left), operator, Box::new(self.factor()?));
        }
    }

    fn factor(&mut self) -> Result<Expr, String> {
        self.skip_space();
        if self.eat(b'(') {
            let inner = self.expression()?;
            return if self.eat(b')') { Ok(inner) } else { Err("a `(` is never closed".into()) };
        }
        let rest = self.rest();
        if let Some(after) = rest.strip_prefix("var(") {
            let end = after.find(')').ok_or("a `var(` is never closed")?;
            let name = after[..end].trim().to_string();
            if !name.starts_with("--") || name.contains(',') {
                return Err(format!("unsupported var({name})"));
            }
            self.at += 4 + end + 1;
            if !self.params.contains(&name) {
                self.params.push(name.clone());
            }
            return Ok(Expr::Param(name));
        }
        for (prefix, function) in [("max(", Function::Max), ("min(", Function::Min), ("clamp(", Function::Clamp), ("calc(", Function::Calc)] {
            if rest.starts_with(prefix) {
                self.at += prefix.len();
                let mut arguments = vec![self.expression()?];
                while self.eat(b',') {
                    arguments.push(self.expression()?);
                }
                if !self.eat(b')') {
                    return Err(format!("`{prefix}` is never closed"));
                }
                let wanted = match function {
                    Function::Calc => 1..=1,
                    Function::Clamp => 3..=3,
                    Function::Max | Function::Min => 2..=usize::MAX,
                };
                if !wanted.contains(&arguments.len()) {
                    return Err(format!("`{prefix}` has {} arguments", arguments.len()));
                }
                return Ok(Expr::Call(function, arguments));
            }
        }
        let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+')).unwrap_or(rest.len());
        let number = rest[..end].parse::<f64>().map_err(|_| format!("cannot read {rest:?}"))?;
        self.at += end;
        let unit_end = self.rest().find(|c: char| !c.is_ascii_alphabetic() && c != '%').unwrap_or(self.rest().len());
        match &self.rest()[..unit_end] {
            "" | "px" => {}
            unit => return Err(format!("unit {unit:?} is not a length in pixels")),
        }
        self.at += unit_end;
        Ok(Expr::Number(number))
    }
}

/// The parameter name of a run-time property: `--ui-scale` is `ui_scale`.
pub fn parameter(property: &str) -> String {
    property.trim_start_matches("--").replace('-', "_")
}

impl Parsed {
    /// The Rust expression, over `f32` parameters named by [`parameter`].
    pub fn rust(&self) -> String {
        print(&self.expression)
    }
}

fn print(expression: &Expr) -> String {
    match expression {
        Expr::Number(value) => format!("{:?}_f32", *value as f32),
        Expr::Param(name) => parameter(name),
        Expr::Binary(left, operator, right) => format!("({} {operator} {})", print(left), print(right)),
        Expr::Call(Function::Calc, arguments) => print(&arguments[0]),
        Expr::Call(Function::Max, arguments) => fold(arguments, "max"),
        Expr::Call(Function::Min, arguments) => fold(arguments, "min"),
        // CSS: clamp(MIN, VALUE, MAX) is max(MIN, min(VALUE, MAX)), without f32::clamp's panic when MIN > MAX.
        Expr::Call(Function::Clamp, arguments) => format!("({}).max(({}).min({}))", print(&arguments[0]), print(&arguments[1]), print(&arguments[2])),
    }
}

fn fold(arguments: &[Expr], method: &str) -> String {
    let mut printed = print(&arguments[0]);
    for argument in &arguments[1..] {
        printed = format!("({printed}).{method}({})", print(argument));
    }
    printed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_topbar_expression_becomes_a_function_body_over_its_runtime_input() {
        let parsed = parse("max(52px, calc(44px / var(--ui-scale)))").unwrap();
        assert_eq!(parsed.params, ["--ui-scale"]);
        assert_eq!(parsed.rust(), "(52.0_f32).max((44.0_f32 / ui_scale))");
    }

    #[test]
    fn operators_keep_css_precedence_and_clamp_is_max_of_min() {
        assert_eq!(parse("calc(2px + 3px * 4)").unwrap().rust(), "(2.0_f32 + (3.0_f32 * 4.0_f32))");
        assert_eq!(parse("calc((2px + 3px) * 4)").unwrap().rust(), "((2.0_f32 + 3.0_f32) * 4.0_f32)");
        assert_eq!(parse("calc(10px - 4px)").unwrap().rust(), "(10.0_f32 - 4.0_f32)");
        assert_eq!(parse("clamp(8px, var(--a), 20px)").unwrap().rust(), "(8.0_f32).max((a).min(20.0_f32))");
        assert_eq!(parse("min(1px, 2px, -3px)").unwrap().rust(), "((1.0_f32).min(2.0_f32)).min(-3.0_f32)");
    }

    #[test]
    fn what_is_not_a_pixel_length_is_an_error() {
        for bad in ["max(1em, 2px)", "calc(100% - 4px)", "max(1px)", "calc(1px", "max(1px, 2px) extra", "calc(var(--a, 3px))", "env(safe-area-inset-top, 0px)"] {
            assert!(parse(bad).is_err(), "{bad} should not parse");
        }
    }
}
