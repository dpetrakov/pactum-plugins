# Raw HTML

<script>alert("xss")</script>

<div onclick="alert(1)" style="color:red">Блок <b>жирный</b></div>

<iframe src="https://evil.example"></iframe>

Абзац с <img src=x onerror="alert(2)"> и <a href="javascript:alert(3)">ссылкой</a> и <span onmouseover="x()">span</span>.

[js link](javascript:alert(4)) and ![img](javascript:alert(5))

<!-- comment -->
