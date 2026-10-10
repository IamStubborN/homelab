import importlib.util
from pathlib import Path
import socket
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "cozylife", Path(__file__).parents[1] / "config/scripts/cozylife_socket.py"
)
cozylife = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cozylife)


class SocketTests(unittest.TestCase):
    def test_missing_state_is_an_error_instead_of_off(self):
        with patch.object(cozylife, "send_command", return_value={}):
            with self.assertRaises(TimeoutError):
                cozylife.query("192.0.2.1")

    def test_retry_recovers_a_dropped_response(self):
        with patch.object(cozylife, "send_command_once", side_effect=[socket.timeout(), {"1": 255}]) as send:
            with patch.object(cozylife.time, "sleep"):
                self.assertTrue(cozylife.query("192.0.2.1"))
        self.assertEqual(send.call_count, 2)

    def test_receive_uses_remaining_budget_after_connection(self):
        # Connect/send consumed 1.5 s. A reply for another serial must not give
        # the next recv a fresh 2.5 s timeout beyond the original deadline.
        with patch.object(cozylife.socket, "socket") as factory:
            sock = factory.return_value.__enter__.return_value
            sock.recv.side_effect = [b'{"sn":"other"}\n', socket.timeout()]
            with patch.object(cozylife.time, "monotonic", side_effect=[0, 1, 1.5, 2]):
                with self.assertRaises(socket.timeout):
                    cozylife.send_command_once("192.0.2.1", 2, {}, "expected")
        self.assertEqual([call.args[0] for call in sock.settimeout.call_args_list], [2.5, 1.5, 1, 0.5])

    def test_exhausted_connection_budget_never_sends_the_command(self):
        with patch.object(cozylife.socket, "socket") as factory:
            sock = factory.return_value.__enter__.return_value
            with patch.object(cozylife.time, "monotonic", side_effect=[0, 3]):
                with self.assertRaises(socket.timeout):
                    cozylife.send_command_once("192.0.2.1", 3, {}, "expected")
        sock.sendall.assert_not_called()


if __name__ == "__main__":
    unittest.main()
