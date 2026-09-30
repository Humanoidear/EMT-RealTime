from datetime import datetime

from app import (_eta_key, bus_direction, norm_line, parse_estado_html, parse_estimations, upcoming_stops)

XML = b"""<?xml version='1.0' encoding='UTF-8'?>
<estimacion parada="25"><solo_parada>
<bus><linea>19</linea><destino><![CDATA[Est.del Nord]]></destino><minutos>3 min.</minutos><horaLlegada/><error/></bus>
<bus><linea>92</linea><destino><![CDATA[Campanar]]></destino><minutos/><horaLlegada>12:15:00</horaLlegada><error/></bus>
</solo_parada></estimacion>"""

est = parse_estimations(XML)
assert est == [
    {"linea": "19", "destino": "Est.del Nord", "minutos": "3 min.", "horaLlegada": ""},
    {"linea": "92", "destino": "Campanar", "minutos": "", "horaLlegada": "12:15:00"},
], est

# ordering key: Next=0, numbered minutes, and scheduled hh:mm:ss from now
now = datetime(2026, 9, 30, 12, 0, 0)
assert _eta_key({"minutos": "Next"}, now) == 0
assert _eta_key({"minutos": "5 min."}, now) == 5
assert _eta_key({"minutos": "", "horaLlegada": "12:10:00"}, now) == 10
assert _eta_key({"minutos": "", "horaLlegada": "11:59:00"}, now) == 1439  # wraps past midnight
assert _eta_key({"minutos": "", "horaLlegada": ""}, now) == 10 ** 9

assert bus_direction("19", 1587, 1589) in ("ida", "vuelta"), "captured bus pair should match"
assert bus_direction("19", 999999, 999998) is None

# a captured position for the 1587->1589 bus (39.4637, -0.3293) heading to 1589
up = upcoming_stops("19", bus_direction("19", 1587, 1589), 1589, 39.463675, -0.329286)
assert up and up[0]["id"] == 1589, up
assert all(a["minutes"] <= b["minutes"] for a, b in zip(up, up[1:])), "ETAs must grow"
assert len(up) > 5

# incidents parser (estado del servicio page) + line normalisation
HTML = """
<section class="estado-servicio">
  <div class="estado-servicio-header"><img alt="icono autobús"/>
    <img alt="Línea 07 - MERCAT CENTRAL - FTA. SANT LLUÍS"/><img alt="Línea 09 - ESTACIÓ DEL NORD"/>
  </div>
  <div class="estado-servicio-footer">
    <div class="estado-servicio-fechas-estado"><span><strong>Desde:</strong> 30/09/2026</span></div>
    <div class="estado-servicio-descripcion"><div class="estado-servicio-descripcion-corta"><p>Obras.</p></div></div>
  </div>
</section>
<section class="estado-servicio">
  <h2><a href="https://www.emtvalencia.es/wp/ultima-hora/x/">Paradas suprimidas de la línea 99.</a></h2>
  <div class="estado-servicio-footer"><div class="estado-servicio-fechas-estado">
    <span><strong>Desde:</strong> 22/09/2026</span></div></div>
</section>
"""
cards = parse_estado_html(HTML)
assert len(cards) == 2, cards
assert cards[0]["lines"] == ["7", "9"] and cards[0]["date"] == "30/09/2026", cards[0]
assert cards[1]["lines"] == ["99"], cards[1]
assert norm_line("07") == "7" and norm_line("C1") == "C1" and norm_line("19") == "19"
print("ok")
