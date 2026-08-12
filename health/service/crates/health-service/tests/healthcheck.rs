use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
};

fn serve_once(response: &'static [u8]) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0_u8; 1024];
        let read = stream.read(&mut request).unwrap();
        assert!(String::from_utf8_lossy(&request[..read]).starts_with("GET /healthz HTTP/1.1\r\n"));
        stream.write_all(response).unwrap();
    });
    (address, handle)
}

#[test]
fn healthcheck_accepts_http_200() {
    let (address, server) = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");

    health_service::healthcheck::check(&address).unwrap();

    server.join().unwrap();
}

#[test]
fn healthcheck_rejects_non_200_status() {
    let (address, server) =
        serve_once(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");

    let error = health_service::healthcheck::check(&address).unwrap_err();

    assert!(error.to_string().contains("503"));
    server.join().unwrap();
}
