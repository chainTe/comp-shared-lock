use crate::Error;

pub struct MessageFields<'a> {
    pub address: Option<&'a str>,
    pub signature: Option<&'a str>,
    pub extensions: Option<&'a str>,
}

pub fn parse_message(s: &str) -> Result<MessageFields<'_>, Error> {
    let b = s.as_bytes();
    let mut fields = MessageFields {
        address: None,
        signature: None,
        extensions: None,
    };
    let mut i = skip_ws(b, 0);
    if b.get(i) != Some(&b'{') {
        return Err(Error::WitnessFormat);
    }
    i += 1;
    i = skip_ws(b, i);
    if b.get(i) == Some(&b'}') {
        return Ok(fields);
    }
    loop {
        i = skip_ws(b, i);
        if b.get(i) != Some(&b'"') {
            return Err(Error::WitnessFormat);
        }
        let (key, ni) = parse_string(b, i)?;
        i = skip_ws(b, ni);
        if b.get(i) != Some(&b':') {
            return Err(Error::WitnessFormat);
        }
        i = skip_ws(b, i + 1);
        let (value, ni) = parse_value(b, i)?;
        i = ni;
        match (key, value) {
            ("address", JsonValue::Null) => {}
            ("address", JsonValue::Str(v)) => fields.address = Some(v),
            ("signature", JsonValue::Null) => {}
            ("signature", JsonValue::Str(v)) => fields.signature = Some(v),
            ("extensions", JsonValue::Raw(v)) => fields.extensions = Some(v),
            ("extensions", JsonValue::Null) => {}
            _ => {}
        }
        i = skip_ws(b, i);
        match b.get(i) {
            Some(b',') => {
                i += 1;
            }
            Some(b'}') => {
                return Ok(fields);
            }
            _ => return Err(Error::WitnessFormat),
        }
    }
}

enum JsonValue<'a> {
    Null,
    Str(&'a str),
    Raw(&'a str),
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while let Some(c) = b.get(i) {
        if *c == b' ' || *c == b'\t' || *c == b'\n' || *c == b'\r' {
            i += 1;
        } else {
            break;
        }
    }
    i
}

fn parse_string<'a>(b: &'a [u8], i: usize) -> Result<(&'a str, usize), Error> {
    if b.get(i) != Some(&b'"') {
        return Err(Error::WitnessFormat);
    }
    let start = i + 1;
    let mut j = start;
    while let Some(c) = b.get(j) {
        match *c {
            b'\\' => {
                j += 2;
                continue;
            }
            b'"' => {
                let s = core::str::from_utf8(&b[start..j]).map_err(|_| Error::WitnessFormat)?;
                return Ok((s, j + 1));
            }
            _ => j += 1,
        }
    }
    Err(Error::WitnessFormat)
}

fn parse_value<'a>(b: &'a [u8], i: usize) -> Result<(JsonValue<'a>, usize), Error> {
    match b.get(i) {
        Some(b'"') => {
            let (s, ni) = parse_string(b, i)?;
            Ok((JsonValue::Str(s), ni))
        }
        Some(b'n') => {
            if b.get(i..i + 4) == Some(b"null") {
                Ok((JsonValue::Null, i + 4))
            } else {
                Err(Error::WitnessFormat)
            }
        }
        Some(b'{') => {
            let end = match_bracket(b, i, b'{', b'}')?;
            let raw = core::str::from_utf8(&b[i..end]).map_err(|_| Error::WitnessFormat)?;
            Ok((JsonValue::Raw(raw), end))
        }
        Some(b'[') => {
            let end = match_bracket(b, i, b'[', b']')?;
            let raw = core::str::from_utf8(&b[i..end]).map_err(|_| Error::WitnessFormat)?;
            Ok((JsonValue::Raw(raw), end))
        }
        Some(c) if *c == b't' || *c == b'f' || *c == b'-' || c.is_ascii_digit() => {
            let mut j = i;
            while let Some(c) = b.get(j) {
                if *c == b','
                    || *c == b'}'
                    || *c == b']'
                    || *c == b' '
                    || *c == b'\t'
                    || *c == b'\n'
                    || *c == b'\r'
                {
                    break;
                }
                j += 1;
            }
            Ok((JsonValue::Null, j))
        }
        _ => Err(Error::WitnessFormat),
    }
}

fn match_bracket(b: &[u8], start: usize, open: u8, close: u8) -> Result<usize, Error> {
    let mut depth = 0usize;
    let mut i = start;
    while let Some(c) = b.get(i) {
        match *c {
            b'"' => {
                let (_, ni) = parse_string(b, i)?;
                i = ni;
                continue;
            }
            _ if *c == open => depth += 1,
            _ if *c == close => {
                depth -= 1;
                if depth == 0 {
                    return Ok(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err(Error::WitnessFormat)
}
