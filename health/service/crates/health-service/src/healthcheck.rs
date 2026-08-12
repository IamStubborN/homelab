use std::{
    io::{self, BufRead, BufReader, Write},
    net::{TcpStream, ToSocketAddrs},
    time::Duration,
};

pub fn check(address: &str) -> io::Result<()> {
    let address = address
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "address resolved empty"))?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(4))?;
    stream.set_read_timeout(Some(Duration::from_secs(4)))?;
    stream.set_write_timeout(Some(Duration::from_secs(4)))?;
    stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;

    let mut status = String::new();
    BufReader::new(stream).read_line(&mut status)?;
    let code = status
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP status line"))?;
    if code == "200" {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "health endpoint returned HTTP {code}"
        )))
    }
}
