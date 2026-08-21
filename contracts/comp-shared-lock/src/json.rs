use crate::Error;

pub struct MessageFields<'a> {
    pub public_key: Option<&'a str>,
    pub signature: Option<&'a str>,
    pub extensions: Option<&'a str>,
}

pub fn parse_message(s: &str) -> Result<MessageFields<'_>, Error> {
    let b = s.as_bytes();
    let mut fields = MessageFields {
        public_key: None,
        signature: None,
        extensions: None,
    };
    let mut seen_public_key = false;
    let mut seen_signature = false;
    let mut seen_extensions = false;
    let mut i = skip_ws(b, 0);
    if b.get(i) != Some(&b'{') {
        return Err(Error::WitnessFormat);
    }
    i += 1;
    i = skip_ws(b, i);
    if b.get(i) == Some(&b'}') {
        return finish(b, i + 1, fields);
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
        match key {
            "public_key" => {
                if seen_public_key {
                    return Err(Error::WitnessFormat);
                }
                seen_public_key = true;
                match value {
                    JsonValue::Null => {}
                    JsonValue::Str(v) => fields.public_key = Some(v),
                    _ => return Err(Error::WitnessFormat),
                }
            }
            "signature" => {
                if seen_signature {
                    return Err(Error::WitnessFormat);
                }
                seen_signature = true;
                match value {
                    JsonValue::Null => {}
                    JsonValue::Str(v) => fields.signature = Some(v),
                    _ => return Err(Error::WitnessFormat),
                }
            }
            "extensions" => {
                if seen_extensions {
                    return Err(Error::WitnessFormat);
                }
                seen_extensions = true;
                match value {
                    JsonValue::Null => {}
                    JsonValue::Raw(v) => fields.extensions = Some(v),
                    _ => return Err(Error::WitnessFormat),
                }
            }
            _ => {}
        }
        i = skip_ws(b, i);
        match b.get(i) {
            Some(b',') => {
                i += 1;
            }
            Some(b'}') => {
                return finish(b, i + 1, fields);
            }
            _ => return Err(Error::WitnessFormat),
        }
    }
}

enum JsonValue<'a> {
    Null,
    Str(&'a str),
    Raw(&'a str),
    Other,
}

fn finish<'a>(b: &[u8], i: usize, fields: MessageFields<'a>) -> Result<MessageFields<'a>, Error> {
    if skip_ws(b, i) == b.len() {
        Ok(fields)
    } else {
        Err(Error::WitnessFormat)
    }
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

fn parse_string(b: &[u8], i: usize) -> Result<(&str, usize), Error> {
    if b.get(i) != Some(&b'"') {
        return Err(Error::WitnessFormat);
    }
    let start = i + 1;
    let mut j = start;
    while let Some(c) = b.get(j) {
        match *c {
            b'\\' => {
                let escaped = *b.get(j + 1).ok_or(Error::WitnessFormat)?;
                match escaped {
                    b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => j += 2,
                    b'u' => {
                        let digits = b.get(j + 2..j + 6).ok_or(Error::WitnessFormat)?;
                        if !digits.iter().all(|digit| digit.is_ascii_hexdigit()) {
                            return Err(Error::WitnessFormat);
                        }
                        j += 6;
                    }
                    _ => return Err(Error::WitnessFormat),
                }
            }
            b'"' => {
                let s = core::str::from_utf8(&b[start..j]).map_err(|_| Error::WitnessFormat)?;
                return Ok((s, j + 1));
            }
            0x00..=0x1f => return Err(Error::WitnessFormat),
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
            let end = match_compound(b, i)?;
            let raw = core::str::from_utf8(&b[i..end]).map_err(|_| Error::WitnessFormat)?;
            Ok((JsonValue::Raw(raw), end))
        }
        Some(b'[') => {
            let end = match_compound(b, i)?;
            let raw = core::str::from_utf8(&b[i..end]).map_err(|_| Error::WitnessFormat)?;
            Ok((JsonValue::Raw(raw), end))
        }
        Some(b't') if b.get(i..i + 4) == Some(b"true") => Ok((JsonValue::Other, i + 4)),
        Some(b'f') if b.get(i..i + 5) == Some(b"false") => Ok((JsonValue::Other, i + 5)),
        Some(b'-' | b'0'..=b'9') => {
            let end = parse_number(b, i)?;
            Ok((JsonValue::Other, end))
        }
        _ => Err(Error::WitnessFormat),
    }
}

fn parse_number(b: &[u8], start: usize) -> Result<usize, Error> {
    let mut i = start;
    if b.get(i) == Some(&b'-') {
        i += 1;
    }
    match b.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => {
            i += 1;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
        }
        _ => return Err(Error::WitnessFormat),
    }
    if b.get(i) == Some(&b'.') {
        i += 1;
        let first = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == first {
            return Err(Error::WitnessFormat);
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let first = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == first {
            return Err(Error::WitnessFormat);
        }
    }
    Ok(i)
}

fn match_compound(b: &[u8], start: usize) -> Result<usize, Error> {
    const MAX_NESTING: usize = 64;
    fn value(b: &[u8], start: usize, depth: usize) -> Result<usize, Error> {
        if depth >= MAX_NESTING {
            return Err(Error::WitnessFormat);
        }
        match b.get(start) {
            Some(b'"') => parse_string(b, start).map(|(_, end)| end),
            Some(b'{') => object(b, start, depth + 1),
            Some(b'[') => array(b, start, depth + 1),
            Some(b'n') if b.get(start..start + 4) == Some(b"null") => Ok(start + 4),
            Some(b't') if b.get(start..start + 4) == Some(b"true") => Ok(start + 4),
            Some(b'f') if b.get(start..start + 5) == Some(b"false") => Ok(start + 5),
            Some(b'-' | b'0'..=b'9') => parse_number(b, start),
            _ => Err(Error::WitnessFormat),
        }
    }

    fn object(b: &[u8], start: usize, depth: usize) -> Result<usize, Error> {
        let mut i = skip_ws(b, start + 1);
        if b.get(i) == Some(&b'}') {
            return Ok(i + 1);
        }
        loop {
            let (_, end) = parse_string(b, i)?;
            i = skip_ws(b, end);
            if b.get(i) != Some(&b':') {
                return Err(Error::WitnessFormat);
            }
            i = skip_ws(b, i + 1);
            i = skip_ws(b, value(b, i, depth)?);
            match b.get(i) {
                Some(b',') => i = skip_ws(b, i + 1),
                Some(b'}') => return Ok(i + 1),
                _ => return Err(Error::WitnessFormat),
            }
        }
    }

    fn array(b: &[u8], start: usize, depth: usize) -> Result<usize, Error> {
        let mut i = skip_ws(b, start + 1);
        if b.get(i) == Some(&b']') {
            return Ok(i + 1);
        }
        loop {
            i = skip_ws(b, value(b, i, depth)?);
            match b.get(i) {
                Some(b',') => i = skip_ws(b, i + 1),
                Some(b']') => return Ok(i + 1),
                _ => return Err(Error::WitnessFormat),
            }
        }
    }

    match b.get(start) {
        Some(b'{') => object(b, start, 1),
        Some(b'[') => array(b, start, 1),
        _ => Err(Error::WitnessFormat),
    }
}
